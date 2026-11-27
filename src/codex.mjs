import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const posix = process.platform !== 'win32';
const timeoutMs = 10 * 60 * 1000;
const maxAnswerLength = 32000;
const maxStderrLength = 2000;
const maxSampleCommands = 10;
const maxModifiedFiles = 50;

export async function findCodex() {
  const override = process.env.CODEX_DELEGATE_BIN;
  if (override) {
    if (!isAbsolute(override)) throw new Error('CODEX_DELEGATE_BIN must be an absolute executable path.');
    try {
      await access(override, constants.X_OK);
      return override;
    } catch {
      throw new Error('The Codex executable specified by CODEX_DELEGATE_BIN is unavailable.');
    }
  }

  const home = homedir();
  const directories = [
    ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute),
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/opt/local/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  const filename = posix ? 'codex' : 'codex.exe';
  for (const directory of new Set(directories)) {
    const executable = join(directory, filename);
    try {
      await access(executable, constants.X_OK);
      return executable;
    } catch {
      // Search the next directory.
    }
  }
  throw new Error('Codex CLI was not found. Install it or set CODEX_DELEGATE_BIN to its absolute path.');
}

async function resolveGitWorktreeDirs(workspace) {
  const dirs = new Set();
  try {
    const dotGit = join(workspace, '.git');
    const info = await lstat(dotGit);
    if (!info.isFile()) return [];
    const content = await readFile(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (!match) return [];
    const gitDir = await realpath(resolve(workspace, match[1].trim()));
    dirs.add(gitDir);
    try {
      const commonRaw = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
      if (commonRaw) {
        const commonDir = await realpath(resolve(gitDir, commonRaw));
        dirs.add(commonDir);
      }
    } catch {
      // No commondir file; single gitdir is sufficient.
    }
  } catch {
    // Not a linked Git worktree or .git is inaccessible.
  }
  return [...dirs];
}

function buildBaseArgs(workspace, sandbox, reasoningEffort, extraWritableDirs) {
  const effectiveSandbox = sandbox === 'workspace-write' ? 'workspace-write' : 'read-only';
  const args = [
    '--no-daemon',
    '-a', 'never',
    '-s', effectiveSandbox,
    '-C', workspace,
  ];
  for (const dir of extraWritableDirs) {
    args.push('--add-dir', dir);
  }
  args.push(
    '--disable', 'apps',
    '--disable', 'plugins',
    '--disable', 'hooks',
    '-c', 'mcp_servers={}',
    '-c', 'web_search="disabled"',
  );
  if (reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  return args;
}

function buildCommandArgs(options, schemaPath, extraWritableDirs) {
  const args = buildBaseArgs(options.workspace, options.sandbox, options.reasoningEffort, extraWritableDirs);
  if (options.mode === 'review') {
    args.push('exec', 'review', '--json');
    if (options.model) args.push('--model', options.model);
    switch (options.target) {
      case 'uncommitted':
        args.push('--uncommitted');
        return { args, stdinPayload: undefined };
      case 'base':
        args.push('--base', options.base);
        return { args, stdinPayload: undefined };
      case 'commit':
        args.push('--commit', options.commit);
        if (options.title) args.push('--title', options.title);
        return { args, stdinPayload: undefined };
      case 'custom':
        args.push('-');
        return { args, stdinPayload: options.instructions };
      default:
        throw new Error(`Unsupported review target: ${options.target}`);
    }
  }

  args.push('exec');
  if (options.forkSessionId && !options.sessionId) {
    args.push('fork', '--json', '--skip-git-repo-check');
    if (options.model) args.push('--model', options.model);
    if (schemaPath) args.push('--output-schema', schemaPath);
    args.push(options.forkSessionId, '-');
    return { args, stdinPayload: options.task };
  }

  if (options.sessionId) {
    args.push('resume', '--json', '--skip-git-repo-check');
    if (options.model) args.push('--model', options.model);
    if (schemaPath) args.push('--output-schema', schemaPath);
    args.push(options.sessionId, '-');
    return { args, stdinPayload: options.task };
  }

  args.push('--json', '--skip-git-repo-check');
  if (options.model) args.push('--model', options.model);
  if (schemaPath) args.push('--output-schema', schemaPath);
  args.push('-');
  return { args, stdinPayload: options.task };
}

export async function runCodex(executable, options) {
  const startedAt = Date.now();
  const extraWritableDirs = options.sandbox === 'workspace-write'
    ? await resolveGitWorktreeDirs(options.workspace)
    : [];

  let tempDir;
  let schemaPath;
  if (options.outputSchema) {
    tempDir = await mkdtemp(join(tmpdir(), 'agy-codex-schema-'));
    schemaPath = join(tempDir, 'output-schema.json');
    await writeFile(schemaPath, JSON.stringify(options.outputSchema), 'utf8');
    await chmod(schemaPath, 0o600);
  }

  let commandSpec;
  try {
    commandSpec = buildCommandArgs(options, schemaPath, extraWritableDirs);
  } catch (error) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  if (options.signal?.aborted) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    return {
      done: Promise.resolve({ status: 'cancelled', duration_ms: Date.now() - startedAt }),
      kill: () => {},
    };
  }

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;

  const child = spawn(executable, commandSpec.args, {
    cwd: options.workspace,
    detached: posix,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let sessionId = options.forkSessionId && !options.sessionId ? undefined : options.sessionId;
  let rawAnswer;
  let usage;
  let completed = false;
  let failure;
  let stderrTail = '';
  let stopReason;
  let killTimer;
  let commandsRun = 0;
  const sampleCommands = [];
  const filesModified = new Set();

  function signalChild(sig) {
    if (child.pid === undefined) return;
    try {
      if (posix) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch (error) {
      if (error.code !== 'ESRCH') console.error('Could not signal the Codex worker:', error.code);
    }
  }

  function stop(reason) {
    if (stopReason) return;
    stopReason = reason;
    signalChild('SIGTERM');
    killTimer = setTimeout(() => signalChild('SIGKILL'), 1500);
    killTimer.unref();
  }

  const onAbort = () => stop('cancel');
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const timeout = setTimeout(() => stop('timeout'), timeoutMs);
  timeout.unref();

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-maxStderrLength);
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') sessionId = event.thread_id;
        break;
      case 'item.completed':
        if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          rawAnswer = event.item.text;
        } else if (event.item?.type === 'command_execution') {
          commandsRun += 1;
          const cmd = Array.isArray(event.item.command)
            ? event.item.command.join(' ')
            : typeof event.item.command === 'string'
              ? event.item.command
              : undefined;
          if (cmd && sampleCommands.length < maxSampleCommands) {
            sampleCommands.push(cmd.slice(0, 200));
          }
        } else if (event.item?.type === 'file_change') {
          const candidates = Array.isArray(event.item.changes)
            ? event.item.changes.map((c) => c?.path)
            : [event.item.path];
          for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate && filesModified.size < maxModifiedFiles) {
              filesModified.add(candidate);
            }
          }
        }
        break;
      case 'turn.completed':
        completed = true;
        usage = event.usage;
        break;
      case 'turn.failed':
        failure = event.error?.message ?? failure;
        break;
      case 'error':
        failure = event.message ?? failure;
        break;
    }
  });

  child.stdin.on('error', () => {
    // An exec startup failure closes the pipe; the close handler reports the exit.
  });
  if (commandSpec.stdinPayload !== undefined) {
    child.stdin.end(commandSpec.stdinPayload);
  } else {
    child.stdin.end();
  }

  const done = new Promise((resolveDone) => {
    child.once('error', (error) => {
      failure = `Could not launch Codex CLI (${error.code ?? 'unknown error'}).`;
    });
    child.once('close', async (code, sig) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (tempDir) {
        try {
          await rm(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore temporary directory cleanup errors.
        }
      }

      const durationMs = Date.now() - startedAt;
      if (stopReason === 'cancel') {
        return resolveDone({ status: 'cancelled', duration_ms: durationMs });
      }
      if (stopReason === 'timeout') {
        return resolveDone({
          status: 'failed',
          error: 'Codex exceeded the 10-minute execution limit.',
          duration_ms: durationMs,
        });
      }
      if (code === 0 && completed && sessionId && rawAnswer !== undefined) {
        const answer = rawAnswer.slice(0, maxAnswerLength);
        const answerTruncated = rawAnswer.length > maxAnswerLength;
        let answerParsed;
        if (options.outputSchema && !answerTruncated) {
          try {
            answerParsed = JSON.parse(answer);
          } catch {
            // Keep raw answer text if JSON parsing fails.
          }
        }
        return resolveDone({
          status: 'completed',
          session_id: sessionId,
          answer,
          ...(answerParsed !== undefined ? { answer_parsed: answerParsed } : {}),
          answer_truncated: answerTruncated,
          inspected: {
            commands_run: commandsRun,
            sample_commands: sampleCommands,
            files_modified: [...filesModified],
          },
          ...(usage !== undefined ? { usage } : {}),
          duration_ms: durationMs,
        });
      }

      const trimmedStderr = stderrTail.trim();
      const detail = typeof failure === 'string' && failure.trim()
        ? failure.trim().slice(0, 1200)
        : trimmedStderr
          ? `Codex CLI exited (${sig ?? code ?? 'unknown status'}): ${trimmedStderr.slice(0, 1000)}`
          : `Codex exited without a final response (${sig ?? code ?? 'unknown status'}). Verify ChatGPT login via "codex login status" (API key env vars are stripped by design).`;
      resolveDone({ status: 'failed', error: detail, duration_ms: durationMs });
    });
  });

  return { done, kill: () => signalChild('SIGKILL') };
}
