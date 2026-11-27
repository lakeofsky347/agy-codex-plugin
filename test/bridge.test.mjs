import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const bridgePath = fileURLToPath(new URL('../dist/mcp-server.mjs', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fake-codex.fixture', import.meta.url));

async function createTestEnv(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-codex-bridge-test-'));
  const root = await realpath(dir);
  const workspace = join(root, 'workspace');
  const pluginData = join(root, 'plugin-data');
  const bin = join(root, 'bin');
  const fakeCodex = join(bin, 'codex.mjs');
  await mkdir(workspace);
  await mkdir(pluginData);
  await mkdir(bin);
  await copyFile(fixturePath, fakeCodex);
  await chmod(fakeCodex, 0o755);

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return { root, workspace, pluginData, bin, fakeCodex };
}

async function connect(t, envPaths, extraEnv = {}) {
  const paths = envPaths ?? await createTestEnv(t);
  const server = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      CODEX_DELEGATE_BIN: paths.fakeCodex,
      PLUGIN_DATA: paths.pluginData,
      OPENAI_API_KEY: 'should-be-stripped',
      CODEX_API_KEY: 'should-be-stripped',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(server, 'close');
  t.after(async () => {
    server.kill();
    await closed;
  });

  let stderr = '';
  server.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  let nextRequestId = 0;
  const pending = new Map();

  function rejectPending(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  server.on('close', (code, signal) => {
    rejectPending(new Error(`MCP server closed (${code ?? signal}): ${stderr}`));
  });
  server.on('error', rejectPending);
  server.stdin.on('error', rejectPending);
  createInterface({ input: server.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rejectPending(new Error(`Non-JSON data on MCP stdout: ${line}`));
      return;
    }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    request.resolve(message);
  });

  function send(message) {
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  function callWithId(method, params) {
    const id = ++nextRequestId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}: ${stderr}`));
      }, 8_000);
      pending.set(id, {
        resolve(message) { clearTimeout(timer); resolve(message); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      send({ id, method, params });
    });
    return { id, promise };
  }

  async function call(method, params) {
    return callWithId(method, params).promise;
  }

  const initialized = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bridge-test', version: '0.3.0' },
  });
  assert.equal(initialized.result?.protocolVersion, '2025-06-18');
  assert.ok(initialized.result.capabilities.tools);
  send({ method: 'notifications/initialized' });

  async function tool(name, args) {
    const message = await call('tools/call', { name, arguments: args });
    assert.equal(message.error, undefined, JSON.stringify(message));
    assert.equal(message.result?.isError, undefined, JSON.stringify(message));
    assert.ok(message.result?.structuredContent, JSON.stringify(message));
    return message.result.structuredContent;
  }

  async function toolError(name, args) {
    const message = await call('tools/call', { name, arguments: args });
    assert.equal(message.error, undefined, JSON.stringify(message));
    assert.equal(message.result?.isError, true, JSON.stringify(message));
    return message.result.content?.[0]?.text ?? '';
  }

  return { ...paths, send, call, callWithId, tool, toolError };
}

test('background tool declarations leave toolSummary to Antigravity', async (t) => {
  const client = await connect(t);
  const listed = await client.call('tools/list', {});
  const tools = new Map(listed.result?.tools?.map((entry) => [entry.name, entry.inputSchema]) ?? []);
  assert.deepEqual([...tools.keys()].sort(), ['codex_consult', 'codex_review', 'codex_swarm', 'codex_swarm_turn']);

  for (const name of ['codex_consult', 'codex_review', 'codex_swarm_turn']) {
    const schema = tools.get(name);
    const required = schema.required ?? [];
    assert.equal(new Set(required).size, required.length, `${name} declares duplicate required properties.`);
    assert.equal(Object.hasOwn(schema.properties, 'toolSummary'), false, `${name} declares the host's toolSummary field.`);
    const requiredAfterHostInjection = [...required, 'toolSummary'];
    assert.equal(new Set(requiredAfterHostInjection).size, requiredAfterHostInjection.length, name);
  }
});

test('codex_swarm models queries ChatGPT Codex models, rate limits, and rejects non-ChatGPT auth', async (t) => {
  const client = await connect(t);
  const defaultCatalog = await client.tool('codex_swarm', { action: 'models' });
  assert.equal(defaultCatalog.authenticated, true);
  assert.equal(defaultCatalog.auth_type, 'chatgpt');
  assert.equal(defaultCatalog.plan_type, 'prolite');
  assert.deepEqual(defaultCatalog.models.map((m) => m.model), ['gpt-6.2-sol', 'gpt-6.2-astra']);
  assert.ok(defaultCatalog.models[0].supported_reasoning_efforts.includes('ultra'));
  assert.equal(defaultCatalog.rate_limits.rateLimits.primary.usedPercent, 12);

  const fullCatalog = await client.tool('codex_swarm', { action: 'models', all: true });
  assert.deepEqual(fullCatalog.models.map((m) => m.model), ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-reserve']);

  const unauthClient = await connect(t, undefined, { FAKE_CODEX_AUTH_MODE: 'none' });
  const authErr = await unauthClient.toolError('codex_swarm', { action: 'models' });
  assert.match(authErr, /not logged in with ChatGPT/i);
});

test('model refresh falls back to cache while account read failures stay explicit', async (t) => {
  const paths = await createTestEnv(t);
  const codexHome = join(paths.root, 'codex-home');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [{ slug: 'gpt-example-cache', display_name: 'Cached GPT model', visibility: 'list' }],
  }), 'utf8');

  const modelFailure = await connect(t, paths, { CODEX_HOME: codexHome, FAKE_CODEX_RPC_ERROR: 'model/list' });
  const cached = await modelFailure.tool('codex_swarm', { action: 'models' });
  assert.equal(cached.source, 'cache');
  assert.equal(cached.authenticated, null);
  assert.deepEqual(cached.models.map(({ model }) => model), ['gpt-example-cache']);
  assert.match(cached.note, /model\/list failed: simulated RPC error/);

  const noCache = await connect(t, paths, { CODEX_HOME: paths.root, FAKE_CODEX_RPC_ERROR: 'model/list' });
  assert.match(await noCache.toolError('codex_swarm', { action: 'models' }), /model\/list failed: simulated RPC error/);

  const authFailure = await connect(t, paths, { CODEX_HOME: codexHome, FAKE_CODEX_RPC_ERROR: 'account/read' });
  assert.match(await authFailure.toolError('codex_swarm', { action: 'models' }), /account\/read failed: simulated RPC error/);
});

async function waitForFixture(condition, message) {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) await delay(20);
  assert.ok(condition(), message);
}

test('concurrent dispatch reserves at most four Codex subprocesses', async (t) => {
  const client = await connect(t);
  const calls = Array.from({ length: 7 }, (_, index) => {
    const marker = `limit-${index}`;
    const call = client.callWithId('tools/call', {
      name: 'codex_consult',
      arguments: { workspace: client.workspace, task: `simulate a cancellable job marker:${marker}` },
    });
    const state = { ...call, marker };
    call.promise.then((response) => { state.response = response; }, () => {});
    return state;
  });
  const started = () => calls.filter(({ marker }) => existsSync(join(client.bin, `${marker}.started`)));
  await waitForFixture(() => started().length >= 4, 'Expected capacity for four simultaneous Codex subprocesses.');
  await waitForFixture(() => calls.filter(({ response }) => response).length === 3, 'Expected three prompt capacity errors.');
  const active = started();
  assert.equal(active.length, 4);
  for (const { response } of calls.filter((entry) => entry.response)) {
    assert.equal(response.result?.isError, true);
    assert.match(response.result.content?.[0]?.text, /four|capacity|limit/i);
  }
  for (const { id } of active) {
    client.send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'Test cleanup' } });
  }
  await waitForFixture(() => active.every(({ marker }) => existsSync(join(client.bin, `${marker}.terminated`))), 'Expected all four held subprocesses to terminate.');
});

test('simultaneous turns for one Swarm member reserve only one session', async (t) => {
  const client = await connect(t, undefined, { PLUGIN_DATA: '' });
  const swarmId = 'swarm-reservation';
  const member = 'builder';
  await client.tool('codex_swarm', {
    action: 'bind', swarm_id: swarmId, member, workspace: client.workspace, sandbox: 'workspace-write',
  });
  const calls = ['duplicate-alpha', 'duplicate-beta'].map((marker) => {
    const call = client.callWithId('tools/call', {
      name: 'codex_swarm_turn',
      arguments: {
        swarm_id: swarmId,
        member,
        workspace: client.workspace,
        sandbox: 'workspace-write',
        prompt: `simulate a cancellable job marker:${marker}`,
      },
    });
    return { ...call, marker };
  });
  for (const { promise } of calls) promise.catch(() => {});
  const response = await Promise.race([
    ...calls.map(({ promise }) => promise),
    delay(2_000, null, { ref: false }),
  ]);
  assert.equal(response?.result?.isError, true, 'Expected one duplicate turn to be rejected before either Codex job finishes.');
  assert.match(response.result.content?.[0]?.text, /active|running|pending/i);

  const active = calls.find(({ id }) => id !== response.id);
  await waitForFixture(() => existsSync(join(client.bin, `${active.marker}.started`)), 'Expected the admitted turn to start.');
  assert.equal(existsSync(join(client.bin, `${calls.find(({ id }) => id === response.id).marker}.started`)), false);
  const configureError = await client.toolError('codex_swarm', { action: 'configure', swarm_id: swarmId, member, model: 'gpt-6.2-astra' });
  assert.match(configureError, /active|running|pending/i);

  const released = await client.tool('codex_swarm', { action: 'release', swarm_id: swarmId, member });
  assert.equal(released.cancelled_active_turn, true);
  const activeResponse = await active.promise;
  assert.equal(activeResponse.result?.isError, true);
  await waitForFixture(() => existsSync(join(client.bin, `${active.marker}.terminated`)), 'Expected release to terminate the admitted turn.');
});

test('workspace-write requires a writable member binding and its assigned workspace', async (t) => {
  const client = await connect(t);
  const swarmId = 'swarm-write-binding';
  const turn = {
    swarm_id: swarmId,
    member: 'builder',
    workspace: client.workspace,
    prompt: 'implement the assigned change',
    sandbox: 'workspace-write',
  };
  assert.match(await client.toolError('codex_swarm_turn', turn), /bind/i);

  await client.tool('codex_swarm', {
    action: 'bind', swarm_id: swarmId, member: 'verifier', workspace: client.workspace, sandbox: 'read-only',
  });
  const upgradeError = await client.toolError('codex_swarm_turn', { ...turn, member: 'verifier' });
  assert.match(upgradeError, /bind|read-only/i);

  await client.tool('codex_swarm', {
    action: 'bind', swarm_id: swarmId, member: 'builder', workspace: client.workspace, sandbox: 'workspace-write',
  });
  const otherWorkspace = join(client.root, 'other-workspace');
  await mkdir(otherWorkspace);
  const workspaceError = await client.toolError('codex_swarm_turn', {
    swarm_id: swarmId, member: 'builder', workspace: otherWorkspace, prompt: 'implement in a different workspace',
  });
  assert.match(workspaceError, /workspace/i);

  const status = await client.tool('codex_swarm', { action: 'status', swarm_id: swarmId });
  const builder = status.members.find(({ member }) => member === 'builder');
  assert.equal(builder.workspace, client.workspace);
  assert.equal(builder.turns_completed, 0);
});

test('a read-only turn leaves a writable Swarm member binding intact', async (t) => {
  const client = await connect(t);
  const swarmId = 'swarm-temporary-read-only';
  const member = 'builder';
  const workspace = client.workspace;
  await client.tool('codex_swarm', {
    action: 'bind', swarm_id: swarmId, member, workspace, sandbox: 'workspace-write',
  });

  const inspection = await client.tool('codex_swarm_turn', {
    swarm_id: swarmId, member, workspace, sandbox: 'read-only', prompt: 'inspect only',
  });
  assert.equal(inspection.sandbox, 'read-only');
  assert.ok(JSON.parse(inspection.answer).args.includes('read-only'));
  assert.deepEqual(inspection.inspected.files_modified, []);

  const status = await client.tool('codex_swarm', { action: 'status', swarm_id: swarmId });
  assert.equal(status.members[0].sandbox, 'workspace-write');

  const implementation = await client.tool('codex_swarm_turn', {
    swarm_id: swarmId, member, workspace, prompt: 'implement the assigned change',
  });
  assert.equal(implementation.sandbox, 'workspace-write');
  assert.ok(JSON.parse(implementation.answer).args.includes('workspace-write'));
  assert.equal(implementation.session_id, inspection.session_id);
});

test('Swarm builders (workspace-write + worktree --add-dir) and verifiers run concurrently with lock-safe persistence', async (t) => {
  const paths = await createTestEnv(t);
  const repoGit = join(paths.root, 'repo-git');
  const worktreeGitDir = join(repoGit, 'worktrees', 'author-1');
  const shareWorkspace = join(paths.root, 'author-1-share');
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(shareWorkspace, { recursive: true });
  await writeFile(join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
  await writeFile(join(shareWorkspace, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');

  const client = await connect(t, paths);
  const swarmId = 'swarm-alpha';

  await client.tool('codex_swarm', {
    action: 'bind',
    swarm_id: swarmId,
    member: 'author-1',
    sandbox: 'workspace-write',
    model: 'gpt-6.2-sol',
    reasoning_effort: 'ultra',
    workspace: shareWorkspace,
  });
  await client.tool('codex_swarm', {
    action: 'bind',
    swarm_id: swarmId,
    member: 'verifier-1',
    sandbox: 'read-only',
    model: 'gpt-6.2-astra',
    reasoning_effort: 'high',
    workspace: paths.workspace,
  });

  const [authorTurn, verifierTurn] = await Promise.all([
    client.tool('codex_swarm_turn', {
      swarm_id: swarmId,
      member: 'author-1',
      workspace: shareWorkspace,
      prompt: 'parallel test worker alpha: implement parser fix',
      toolSummary: 'Codex [gpt-6.2-sol · ultra]: Implement parser fix',
    }),
    client.tool('codex_swarm_turn', {
      swarm_id: swarmId,
      member: 'verifier-1',
      workspace: paths.workspace,
      prompt: 'parallel test worker beta: verify module boundaries',
      toolSummary: 'Codex [gpt-6.2-astra · high]: Verify module boundaries',
    }),
  ]);

  assert.equal(authorTurn.sandbox, 'workspace-write');
  assert.equal(authorTurn.model_used, 'gpt-6.2-sol');
  assert.equal(authorTurn.reasoning_effort_used, 'ultra');
  assert.deepEqual(authorTurn.inspected.files_modified, ['src/parser.mjs']);
  assert.equal(authorTurn.turns_completed, 1);

  const authorPayload = JSON.parse(authorTurn.answer);
  assert.ok(authorPayload.args.includes('workspace-write'));
  assert.ok(authorPayload.args.includes('model_reasoning_effort="ultra"'));
  const addDirArgs = [];
  for (let i = 0; i < authorPayload.args.length; i++) {
    if (authorPayload.args[i] === '--add-dir') addDirArgs.push(authorPayload.args[i + 1]);
  }
  assert.ok(addDirArgs.includes(worktreeGitDir), `Expected ${worktreeGitDir} in ${JSON.stringify(addDirArgs)}`);
  assert.ok(addDirArgs.includes(repoGit), `Expected ${repoGit} in ${JSON.stringify(addDirArgs)}`);

  const verifierPayload = JSON.parse(verifierTurn.answer);
  assert.ok(verifierPayload.args.includes('read-only'));
  assert.equal(verifierTurn.inspected.files_modified.length, 0);

  const status = await client.tool('codex_swarm', { action: 'status', swarm_id: swarmId });
  assert.equal(status.members.length, 2);
  const authorStatus = status.members.find((m) => m.member === 'author-1');
  const verifierStatus = status.members.find((m) => m.member === 'verifier-1');
  assert.equal(authorStatus.session_id, authorTurn.session_id);
  assert.equal(verifierStatus.session_id, verifierTurn.session_id);
  assert.equal(authorStatus.total_usage.input_tokens, 11);
  assert.equal(verifierStatus.total_usage.input_tokens, 11);
  assert.deepEqual(authorStatus.last_files_modified, ['src/parser.mjs']);
});

test('codex_swarm configure hot-swaps models preserving session_id, fork_from forks threads, and release cancels active turns', async (t) => {
  const paths = await createTestEnv(t);
  const client = await connect(t, paths);
  const swarmId = 'swarm-beta';

  await client.tool('codex_swarm', {
    action: 'bind',
    swarm_id: swarmId,
    member: 'builder',
    sandbox: 'workspace-write',
    model: 'gpt-6.2-sol',
    reasoning_effort: 'medium',
  });

  const turn1 = await client.tool('codex_swarm_turn', {
    swarm_id: swarmId,
    member: 'builder',
    workspace: paths.workspace,
    prompt: 'first build step',
  });

  await client.tool('codex_swarm', {
    action: 'configure',
    swarm_id: swarmId,
    member: 'builder',
    model: 'gpt-6.2-astra',
    reasoning_effort: 'max',
  });

  const turn2 = await client.tool('codex_swarm_turn', {
    swarm_id: swarmId,
    member: 'builder',
    workspace: paths.workspace,
    prompt: 'second build step after model swap',
    toolSummary: 'Codex [builder]: Second build step',
  });
  assert.equal(turn2.session_id, turn1.session_id);
  assert.equal(turn2.turns_completed, 2);
  assert.equal(turn2.total_usage.input_tokens, 22);
  const turn2Payload = JSON.parse(turn2.answer);
  assert.equal(turn2Payload.isResume, true);
  assert.ok(turn2Payload.args.includes('gpt-6.2-astra'));
  assert.ok(turn2Payload.args.includes('model_reasoning_effort="max"'));

  await client.tool('codex_swarm', {
    action: 'bind',
    swarm_id: swarmId,
    member: 'builder-alt',
    sandbox: 'workspace-write',
    model: 'gpt-6.2-sol',
    reasoning_effort: 'high',
    fork_from: 'builder',
  });

  const forked = await client.tool('codex_swarm_turn', {
    swarm_id: swarmId,
    member: 'builder-alt',
    workspace: paths.workspace,
    prompt: 'explore alternative approach',
    toolSummary: 'Codex [builder-alt]: Forked exploration',
  });
  assert.notEqual(forked.session_id, turn1.session_id);
  const forkedPayload = JSON.parse(forked.answer);
  assert.equal(forkedPayload.isFork, true);
  assert.equal(forkedPayload.forkedFrom, turn1.session_id);

  // Start a cancellable turn and release the member via control plane
  await client.tool('codex_swarm', {
    action: 'bind',
    swarm_id: swarmId,
    member: 'slow-worker',
    sandbox: 'read-only',
  });
  const activeCall = client.callWithId('tools/call', {
    name: 'codex_swarm_turn',
    arguments: {
      swarm_id: swarmId,
      member: 'slow-worker',
      workspace: paths.workspace,
      prompt: 'simulate a cancellable job marker:swarmcancel',
      toolSummary: 'Codex [slow-worker]: Long audit',
    },
  });
  const startedMarker = join(paths.bin, 'swarmcancel.started');
  const terminatedMarker = join(paths.bin, 'swarmcancel.terminated');
  const startDeadline = Date.now() + 4_000;
  while (!existsSync(startedMarker) && Date.now() < startDeadline) await delay(25);
  assert.ok(existsSync(startedMarker), 'Swarm slow-worker did not start.');

  const released = await client.tool('codex_swarm', {
    action: 'release',
    swarm_id: swarmId,
    member: 'slow-worker',
  });
  assert.equal(released.cancelled_active_turn, true);
  assert.equal(released.released, true);

  const stopDeadline = Date.now() + 4_000;
  while (!existsSync(terminatedMarker) && Date.now() < stopDeadline) await delay(25);
  assert.ok(existsSync(terminatedMarker), 'Released Swarm worker did not terminate child process.');

  const activeResp = await activeCall.promise;
  assert.equal(activeResp.result?.isError, true);

  const afterStatus = await client.tool('codex_swarm', { action: 'status', swarm_id: swarmId });
  assert.equal(afterStatus.members.find((m) => m.member === 'slow-worker')?.state, 'released');
});

test('codex_consult runs read-only with schema, cross-restart resume, and audit logs', async (t) => {
  const paths = await createTestEnv(t);
  const firstClient = await connect(t, paths);

  const schema = {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
  };

  const initial = await firstClient.tool('codex_consult', {
    workspace: paths.workspace,
    task: 'initial architectural audit',
    model: 'gpt-6.2-sol',
    reasoning_effort: 'high',
    output_schema: schema,
  });
  assert.ok(initial.answer_parsed);
  assert.deepEqual(initial.answer_parsed.loadedSchema, schema);
  assert.equal(initial.answer_parsed.hasOpenAiKey, false);
  assert.equal(initial.answer_parsed.hasCodexKey, false);
  assert.equal(initial.inspected.commands_run, 1);

  const tempSchemaPath = (await readFile(join(paths.bin, 'last-schema-path.txt'), 'utf8')).trim();
  assert.equal(existsSync(tempSchemaPath), false);

  const secondClient = await connect(t, paths);
  const resumed = await secondClient.tool('codex_consult', {
    workspace: paths.workspace,
    session_id: initial.session_id,
    task: 'follow-up question after restart',
  });
  assert.equal(resumed.session_id, initial.session_id);
  const payload = JSON.parse(resumed.answer);
  assert.equal(payload.isResume, true);
  assert.match(payload.prompt, /follow-up question after restart/);

  const auditLines = (await readFile(join(paths.pluginData, 'history.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(auditLines.length, 2);
});

test('codex_review validates targets and stderr/MCP cancellation behave cleanly', async (t) => {
  const client = await connect(t);

  const uncommitted = await client.tool('codex_review', {
    workspace: client.workspace,
    target: 'uncommitted',
  });
  const uncommittedPayload = JSON.parse(uncommitted.answer);
  assert.equal(uncommittedPayload.isReview, true);
  assert.ok(uncommittedPayload.args.includes('--uncommitted'));

  const conflictError = await client.toolError('codex_review', {
    workspace: client.workspace,
    target: 'uncommitted',
    instructions: 'Check SQL injection too',
  });
  assert.match(conflictError, /does not allow combining "uncommitted" review mode with custom instructions/);

  const stderrCrash = await client.toolError('codex_consult', {
    workspace: client.workspace,
    task: 'simulate stderr startup crash',
  });
  assert.match(stderrCrash, /simulated broken TOML syntax/);

  const { id, promise } = client.callWithId('tools/call', {
    name: 'codex_consult',
    arguments: { workspace: client.workspace, task: 'simulate a cancellable job marker:consultcancel' },
  });
  const startedMarker = join(client.bin, 'consultcancel.started');
  const terminatedMarker = join(client.bin, 'consultcancel.terminated');
  const startDeadline = Date.now() + 4_000;
  while (!existsSync(startedMarker) && Date.now() < startDeadline) await delay(25);
  assert.ok(existsSync(startedMarker));

  client.send({
    method: 'notifications/cancelled',
    params: { requestId: id, reason: 'User cancelled background task' },
  });

  const stopDeadline = Date.now() + 4_000;
  while (!existsSync(terminatedMarker) && Date.now() < stopDeadline) await delay(25);
  assert.ok(existsSync(terminatedMarker));
  await Promise.race([promise.catch(() => {}), delay(300)]);
});
