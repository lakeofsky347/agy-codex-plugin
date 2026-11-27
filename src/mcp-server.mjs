import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { appendFile, mkdir, realpath, rename, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { findCodex, runCodex } from './codex.mjs';
import { listCodexModels } from './codex-models.mjs';
import {
  bindMember,
  completeMemberTurn,
  configureMember,
  getSwarmStatus,
  normalizeSwarmId,
  prepareMemberTurn,
  releaseMember,
  validateMemberName,
} from './swarm-roster.mjs';

const maxActiveJobs = 4;
const maxAuditFileBytes = 512 * 1024;
const active = new Set();
const activeMemberRuns = new Map();

function result(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function resolveWorkspace(workspace) {
  if (!isAbsolute(workspace)) {
    return { error: 'The workspace must be an absolute directory path.' };
  }
  try {
    const resolved = await realpath(workspace);
    if (!(await stat(resolved)).isDirectory()) {
      return { error: 'The workspace must be a local directory.' };
    }
    return { workspace: resolved };
  } catch {
    return { error: 'The workspace directory does not exist or cannot be accessed.' };
  }
}

async function recordAudit(entry) {
  const dataDir = process.env.PLUGIN_DATA;
  if (!dataDir || !isAbsolute(dataDir)) return;
  try {
    await mkdir(dataDir, { recursive: true });
    const logPath = join(dataDir, 'history.jsonl');
    try {
      const info = await stat(logPath);
      if (info.size >= maxAuditFileBytes) {
        await rename(logPath, join(dataDir, 'history.jsonl.1'));
      }
    } catch {
      // File does not exist yet.
    }
    await appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // Audit logging is best-effort and must never fail a tool invocation.
  }
}

async function withCodexSlot(signal, memberKey, execute) {
  if (memberKey && activeMemberRuns.has(memberKey)) {
    const member = memberKey.slice(memberKey.indexOf(':') + 1);
    return toolError(`Swarm member "${member}" already has an active Codex turn.`);
  }
  if (active.size >= maxActiveJobs) {
    return toolError('Four Codex jobs are already active. Wait for one to finish before starting another.');
  }
  const controller = new AbortController();
  const slot = {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    cancel: () => controller.abort(),
  };
  active.add(slot);
  if (memberKey) activeMemberRuns.set(memberKey, slot);
  try {
    return await execute(slot);
  } finally {
    if (memberKey) activeMemberRuns.delete(memberKey);
    active.delete(slot);
  }
}

async function executeCodex(toolName, options, slot) {
  try {
    slot.run = await runCodex(await findCodex(), { ...options, signal: slot.signal });
  } catch (error) {
    return toolError(error.message);
  }

  const outcome = await slot.run.done;
  await recordAudit({
    tool: toolName,
    swarm_id: options.swarmId,
    member: options.member,
    sandbox: options.sandbox ?? 'read-only',
    workspace: options.workspace,
    session_id: outcome.session_id ?? options.sessionId,
    forked_from: options.forkSessionId,
    model: options.model,
    reasoning_effort: options.reasoningEffort,
    status: outcome.status,
    duration_ms: outcome.duration_ms,
    usage: outcome.usage,
    files_modified: outcome.inspected?.files_modified,
    error: outcome.error,
  });
  if (outcome.status === 'completed') return { outcome };
  if (outcome.status === 'cancelled') return toolError('Codex execution was cancelled.');
  return toolError(outcome.error ?? 'Codex execution failed.');
}

function createServer() {
  const server = new McpServer(
    { name: 'codex-delegate', version: '0.3.2' },
    {
      instructions:
        'Bridge Antigravity with the ChatGPT-authenticated local Codex CLI. ' +
        'For /swarm teams using Codex builders or verifiers, use codex_swarm (foreground control: models/status/bind/configure/release) ' +
        'and codex_swarm_turn (background execution bound to a member session). ' +
        'For standalone read-only second opinions or Git reviews, use codex_consult and codex_review.',
    },
  );

  const workspaceSchema = z.string().min(1).max(4096)
    .describe('Absolute path to the workspace directory.');
  const modelSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/).optional()
    .describe('Exact ChatGPT Codex model ID (from codex_swarm models). Omit to use Codex default.');
  const reasoningSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional()
    .describe('Optional Codex reasoning effort override for this turn.');
  const swarmIdSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).optional()
    .describe('Swarm identifier (use the coordinator conversation ID; defaults to "default").');
  const memberSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,23}$/)
    .describe('Swarm worker name (lowercase a-z, 0-9, -, _).');
  const sandboxSchema = z.enum(['workspace-write', 'read-only'])
    .describe('Codex sandbox mode: "workspace-write" for builders/authors in isolated worktrees, "read-only" for verifiers.');

  server.registerTool('codex_swarm', {
    title: 'Manage Codex Swarm Roster & Models',
    description:
      'Foreground control plane for ChatGPT-authenticated Codex CLI workers in an Antigravity Swarm. ' +
      'Actions: "models" (list available ChatGPT Codex models, efforts, and rate limits), ' +
      '"status" (show member bindings, running state, session IDs, and cumulative token usage), ' +
      '"bind" (register a builder or verifier worker with a model, effort, sandbox, or fork_from), ' +
      '"configure" (hot-swap model, effort, or sandbox while keeping the member session_id), ' +
      'and "release" (cancel any active turn and retire a member).',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({
      action: z.enum(['models', 'status', 'bind', 'configure', 'release']),
      swarm_id: swarmIdSchema,
      all: z.boolean().optional()
        .describe('For action="models": include hidden models as well as listed ones.'),
      member: z.string().optional()
        .describe('Target Swarm member name (required for bind, configure, release).'),
      sandbox: sandboxSchema.optional(),
      model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/).nullable().optional()
        .describe('Codex model ID (or null/empty on configure to reset to Codex default).'),
      reasoning_effort: reasoningSchema,
      workspace: workspaceSchema.optional(),
      fork_from: z.string().trim().min(1).max(128).optional()
        .describe('For action="bind": existing member name in this swarm or a Codex session_id UUID to fork from.'),
    }),
  }, async ({ action, swarm_id, all, member, sandbox, model, reasoning_effort, workspace, fork_from }) => {
    try {
      if (action === 'models') {
        const executable = await findCodex();
        const catalog = await listCodexModels(executable, { includeHidden: Boolean(all) });
        if (catalog.authenticated === false) {
          return toolError(catalog.auth_error ?? 'Local Codex CLI is not authenticated with ChatGPT.');
        }
        return result(catalog);
      }

      const id = normalizeSwarmId(swarm_id);

      if (action === 'status') {
        return result(await getSwarmStatus(id, activeMemberRuns));
      }

      if (!member) {
        return toolError(`"member" is required for codex_swarm action "${action}".`);
      }
      validateMemberName(member);

      let resolvedWorkspace;
      if (workspace !== undefined) {
        const check = await resolveWorkspace(workspace);
        if (check.error) return toolError(check.error);
        resolvedWorkspace = check.workspace;
      }

      if (action === 'bind') {
        if (activeMemberRuns.has(`${id}:${member}`)) {
          return toolError(`Member "${member}" is currently running a turn. Wait for it to finish before rebinding.`);
        }
        if (!sandbox) {
          return toolError('Specify "sandbox" ("workspace-write" or "read-only") when binding a member.');
        }
        const bound = await bindMember(id, {
          member,
          sandbox,
          model: model ?? undefined,
          reasoningEffort: reasoning_effort,
          workspace: resolvedWorkspace,
          forkFrom: fork_from,
        });
        return result(bound);
      }

      if (action === 'configure') {
        const isRunning = activeMemberRuns.has(`${id}:${member}`);
        const updated = await configureMember(id, {
          member,
          model,
          reasoningEffort: reasoning_effort,
          sandbox,
        }, isRunning);
        return result(updated);
      }

      if (action === 'release') {
        const key = `${id}:${member}`;
        const activeRun = activeMemberRuns.get(key);
        if (activeRun) activeRun.cancel();
        const released = await releaseMember(id, member);
        return result({ ...released, cancelled_active_turn: Boolean(activeRun) });
      }

      return toolError(`Unsupported action: ${action}`);
    } catch (error) {
      return toolError(error.message);
    }
  });

  // Antigravity adds toolSummary to background tools. Declaring it in a tool's
  // schema can make the host add a duplicate entry to the required array.
  server.registerTool('codex_swarm_turn', {
    title: 'Run Codex Swarm Worker Turn',
    description:
      'Execute one turn for a Swarm worker bound to a local ChatGPT Codex model. Automatically resumes the member\'s ' +
      'persisted Codex session_id (or forks on first turn if bound with fork_from), enables Git worktree writes when ' +
      'configured with workspace-write, and tracks cumulative usage. Runs in background with automatic wakeup.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({
      swarm_id: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).default('default')
        .describe('Swarm identifier matching the coordinator conversation ID.'),
      member: memberSchema,
      workspace: workspaceSchema,
      prompt: z.string().trim().min(1).max(80000)
        .describe('Concrete task or board messages for Codex to execute in this workspace.'),
      sandbox: sandboxSchema.optional()
        .describe('Optional per-turn override. A writable turn requires a workspace-write roster binding. Use read-only to limit this turn.'),
      model: modelSchema,
      reasoning_effort: reasoningSchema,
      fork_from_session_id: z.uuid().optional()
        .describe('Optional Codex session_id UUID to fork from if this member has not yet started a session.'),
      output_schema: z.record(z.string(), z.unknown()).optional()
        .describe('Optional JSON Schema enforcing structured JSON output from Codex.'),
    }),
  }, async ({
    swarm_id = 'default',
    member,
    workspace,
    prompt,
    sandbox,
    model,
    reasoning_effort,
    fork_from_session_id,
    output_schema,
  }, ctx) => {
    const check = await resolveWorkspace(workspace);
    if (check.error) return toolError(check.error);

    const id = normalizeSwarmId(swarm_id);
    const memberKey = `${id}:${member}`;
    return withCodexSlot(ctx?.mcpReq?.signal, memberKey, async (slot) => {
      let binding;
      try {
        binding = await prepareMemberTurn(id, {
          member,
          workspace: check.workspace,
          model,
          reasoningEffort: reasoning_effort,
          sandbox,
          forkFromSessionId: fork_from_session_id,
        });
      } catch (error) {
        return toolError(error.message);
      }
      const execResult = await executeCodex('codex_swarm_turn', {
        mode: 'turn',
        swarmId: id,
        member,
        workspace: check.workspace,
        task: prompt,
        sandbox: binding.sandbox,
        model: binding.model,
        reasoningEffort: binding.reasoning_effort,
        sessionId: binding.session_id,
        forkSessionId: binding.pending_fork_session_id,
        outputSchema: output_schema,
      }, slot);
      if (execResult.isError) return execResult;

      const stats = await completeMemberTurn(id, member, execResult.outcome);
      return result({
        swarm_id: id,
        member,
        sandbox: binding.sandbox,
        model_used: binding.model ?? 'codex-default',
        reasoning_effort_used: binding.reasoning_effort ?? 'codex-default',
        forked_from_session_id: binding.pending_fork_session_id ?? null,
        turns_completed: stats?.turns_completed ?? 1,
        total_usage: stats?.total_usage ?? execResult.outcome.usage ?? null,
        ...execResult.outcome,
      });
    });
  });

  server.registerTool('codex_consult', {
    title: 'Consult Local Codex',
    description:
      'Run a read-only workspace analysis, diagnosis, or follow-up consultation with local Codex and return its final answer, ' +
      'session_id, inspected commands summary, and token usage. Pass a previous session_id to resume that exact Codex conversation.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({
      workspace: workspaceSchema,
      task: z.string().trim().min(1).max(80000)
        .describe('Focused read-only question, relevant file paths, and requested evidence.'),
      session_id: z.uuid().optional()
        .describe('Optional Codex session_id from a prior codex_consult or codex_review call to continue the same thread.'),
      model: modelSchema,
      reasoning_effort: reasoningSchema,
      output_schema: z.record(z.string(), z.unknown()).optional()
        .describe('Optional JSON Schema object enforcing a structured JSON final response from Codex.'),
    }),
  }, async ({ workspace, task, session_id, model, reasoning_effort, output_schema }, ctx) => {
    const check = await resolveWorkspace(workspace);
    if (check.error) return toolError(check.error);
    return withCodexSlot(ctx?.mcpReq?.signal, undefined, async (slot) => {
      const execResult = await executeCodex('codex_consult', {
        mode: 'consult',
        sandbox: 'read-only',
        workspace: check.workspace,
        task,
        sessionId: session_id,
        model,
        reasoningEffort: reasoning_effort,
        outputSchema: output_schema,
      }, slot);
      return execResult.isError ? execResult : result(execResult.outcome);
    });
  });

  server.registerTool('codex_review', {
    title: 'Codex Git Code Review',
    description:
      'Run Codex CLI native non-interactive Git code review in read-only mode against uncommitted changes, a base branch, ' +
      'a specific commit, or custom review instructions. Returns session_id (resumable via codex_consult) and review findings.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({
      workspace: workspaceSchema,
      target: z.enum(['uncommitted', 'base', 'commit', 'custom']).default('uncommitted')
        .describe('What to review: uncommitted working tree changes, diff against a base branch, a single commit, or custom instructions.'),
      base: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/).optional()
        .describe('Base branch or ref when target is "base" (for example, "main" or "origin/main").'),
      commit: z.string().regex(/^[0-9a-fA-F]{4,64}$/).optional()
        .describe('Commit SHA when target is "commit".'),
      title: z.string().trim().min(1).max(200).optional()
        .describe('Optional commit title context when target is "commit".'),
      instructions: z.string().trim().min(1).max(80000).optional()
        .describe('Custom review prompt when target is "custom". Cannot be combined with uncommitted/base/commit targets in Codex CLI.'),
      model: modelSchema,
      reasoning_effort: reasoningSchema,
    }),
  }, async ({ workspace, target = 'uncommitted', base, commit, title, instructions, model, reasoning_effort }, ctx) => {
    const check = await resolveWorkspace(workspace);
    if (check.error) return toolError(check.error);

    if (target === 'base' && !base) {
      return toolError('Provide "base" (branch name) when target is "base".');
    }
    if (target === 'commit' && !commit) {
      return toolError('Provide "commit" (commit SHA) when target is "commit".');
    }
    if (target === 'custom' && !instructions) {
      return toolError('Provide "instructions" when target is "custom".');
    }
    if (target !== 'custom' && instructions) {
      return toolError(
        `Codex CLI does not allow combining "${target}" review mode with custom instructions. ` +
        'Run codex_review without instructions first, then pass its session_id to codex_consult for targeted follow-up questions, ' +
        'or set target="custom" with instructions.',
      );
    }
    if (target !== 'base' && base) {
      return toolError('"base" is only valid when target is "base".');
    }
    if (target !== 'commit' && (commit || title)) {
      return toolError('"commit" and "title" are only valid when target is "commit".');
    }

    return withCodexSlot(ctx?.mcpReq?.signal, undefined, async (slot) => {
      const execResult = await executeCodex('codex_review', {
        mode: 'review',
        sandbox: 'read-only',
        workspace: check.workspace,
        target,
        base,
        commit,
        title,
        instructions,
        model,
        reasoningEffort: reasoning_effort,
      }, slot);
      return execResult.isError ? execResult : result(execResult.outcome);
    });
  });

  return server;
}

function stopWorkers() {
  for (const slot of active) slot.run?.kill();
}
process.on('exit', stopWorkers);
process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));
process.stdin.once('end', () => process.exit(0));

serveStdio(createServer);
