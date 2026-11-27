import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const rpcTimeoutMs = 6000;

class AccountReadError extends Error {}

function rpcFailure(error) {
  return { error: { message: error.message } };
}

function stripApiKeys(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = raw.model ?? raw.slug ?? raw.id;
  if (typeof model !== 'string' || !model) return null;
  const effortsRaw = raw.supportedReasoningEfforts ?? raw.supported_reasoning_levels ?? [];
  const efforts = Array.isArray(effortsRaw)
    ? effortsRaw
        .map((item) => (typeof item === 'string' ? item : (item?.reasoningEffort ?? item?.effort)))
        .filter((val) => typeof val === 'string' && val)
    : [];

  return {
    model,
    display_name: raw.displayName ?? raw.display_name ?? model,
    is_default: Boolean(raw.isDefault),
    default_reasoning_effort: raw.defaultReasoningEffort ?? raw.default_reasoning_level ?? 'medium',
    supported_reasoning_efforts: efforts,
  };
}

async function queryViaAppServer(executable, includeHidden) {
  const child = spawn(
    executable,
    [
      'app-server',
      '--stdio',
      '--disable', 'apps',
      '--disable', 'plugins',
      '--disable', 'hooks',
      '-c', 'mcp_servers={}',
    ],
    {
      env: stripApiKeys(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-1000);
  });

  const pending = new Map();
  let nextId = 0;
  let closed = false;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.id === undefined) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  });

  function rejectAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  child.once('error', (error) => {
    closed = true;
    rejectAll(new Error(`Failed to start Codex app-server (${error.code ?? error.message}).`));
  });

  child.once('close', (code) => {
    closed = true;
    if (pending.size > 0) {
      const suffix = stderrTail.trim() ? `: ${stderrTail.trim()}` : '';
      rejectAll(new Error(`Codex app-server exited (${code ?? 'unknown'})${suffix}`));
    }
  });

  child.stdin.on('error', (error) => {
    closed = true;
    rejectAll(new Error(`Could not send a request to Codex app-server (${error.code ?? error.message}).`));
  });

  function rpc(method, params) {
    if (closed) {
      return Promise.reject(new Error('Codex app-server is not running.'));
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server ${method}.`));
      }, rpcTimeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  try {
    const initResp = await rpc('initialize', {
      clientInfo: { name: 'codex-delegate', version: '0.3.2' },
      capabilities: {},
    });
    if (initResp?.error) {
      throw new Error(initResp.error.message ?? 'Codex app-server initialize failed.');
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    const [accountResp, modelResp, limitsResp] = await Promise.all([
      rpc('account/read', { refreshToken: false }).catch(rpcFailure),
      rpc('model/list', { includeHidden: Boolean(includeHidden) }).catch(rpcFailure),
      rpc('account/rateLimits/read', {}).catch(rpcFailure),
    ]);

    if (accountResp.error) {
      throw new AccountReadError(`Codex app-server account/read failed: ${accountResp.error.message ?? 'unknown error'}`);
    }
    const acct = accountResp?.result?.account;
    if (acct !== null && typeof acct?.type !== 'string') {
      throw new AccountReadError('Codex app-server account/read returned an invalid account response.');
    }
    if (!acct || acct.type !== 'chatgpt') {
      return {
        authenticated: false,
        auth_type: acct?.type ?? null,
        auth_error: 'Local Codex CLI is not logged in with ChatGPT. Run "codex login" first.',
        models: [],
      };
    }

    if (modelResp.error) {
      throw new Error(`Codex app-server model/list failed: ${modelResp.error.message ?? 'unknown error'}`);
    }
    const rawModels = modelResp?.result?.data ?? modelResp?.result?.models;
    if (!Array.isArray(rawModels)) {
      throw new Error('Codex app-server model/list returned an invalid model response.');
    }
    const models = rawModels.map(normalizeModel).filter(Boolean);

    const out = {
      authenticated: true,
      auth_type: 'chatgpt',
      plan_type: acct.planType ?? null,
      source: 'app-server',
      models,
      rate_limits: limitsResp?.result ?? null,
    };
    if (limitsResp?.error?.message) {
      out.rate_limits_note = limitsResp.error.message;
    }
    return out;
  } finally {
    rl.close();
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore already exited child.
    }
  }
}

async function readModelsCacheFallback(includeHidden, appServerError) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const cachePath = join(codexHome, 'models_cache.json');
  const raw = JSON.parse(await readFile(cachePath, 'utf8'));
  const rawModels = Array.isArray(raw?.models) ? raw.models : [];
  const filtered = includeHidden
    ? rawModels
    : rawModels.filter((m) => m?.visibility !== 'hide');
  const models = filtered.map(normalizeModel).filter(Boolean);
  return {
    authenticated: null,
    auth_type: 'chatgpt_cache_fallback',
    source: 'cache',
    note: `app-server query failed (${appServerError}); loaded local models_cache.json.`,
    models,
    rate_limits: null,
  };
}

export async function listCodexModels(executable, { includeHidden = false } = {}) {
  try {
    return await queryViaAppServer(executable, includeHidden);
  } catch (error) {
    if (error instanceof AccountReadError) throw error;
    try {
      return await readModelsCacheFallback(includeHidden, error.message);
    } catch {
      throw error;
    }
  }
}
