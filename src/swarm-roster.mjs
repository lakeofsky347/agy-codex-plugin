import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const SWARM_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const MEMBER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_SANDBOXES = new Set(['workspace-write', 'read-only']);

const memoryStore = new Map();
const locks = new Map();

export function normalizeSwarmId(swarmId) {
  const id = swarmId ?? 'default';
  if (typeof id !== 'string' || !SWARM_ID_RE.test(id)) {
    throw new Error('Invalid swarm_id. Use 1-128 characters of [a-zA-Z0-9._-].');
  }
  return id;
}

export function validateMemberName(member) {
  if (typeof member !== 'string' || !MEMBER_NAME_RE.test(member)) {
    throw new Error('Invalid member name. Use 1-24 lowercase characters of [a-z0-9_-], starting with [a-z0-9].');
  }
  if (member === 'all' || member === 'coordinator' || member.startsWith('coordinator-')) {
    throw new Error(`Member name "${member}" is reserved.`);
  }
}

function withSwarmLock(swarmId, fn) {
  const previous = locks.get(swarmId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const cleanup = next.then(() => {
    if (locks.get(swarmId) === cleanup) locks.delete(swarmId);
  }, () => {
    if (locks.get(swarmId) === cleanup) locks.delete(swarmId);
  });
  locks.set(swarmId, cleanup);
  return next;
}

function rosterFilePath(swarmId) {
  const dataDir = process.env.PLUGIN_DATA;
  if (!dataDir || !isAbsolute(dataDir)) return null;
  return join(dataDir, 'swarms', `${swarmId}.json`);
}

async function loadRoster(swarmId) {
  const filePath = rosterFilePath(swarmId);
  if (filePath) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (!parsed?.members || typeof parsed.members !== 'object' || Array.isArray(parsed.members)) {
        throw new Error('Roster file has an invalid member list.');
      }
      parsed.members = Object.assign(Object.create(null), parsed.members);
      return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Cannot read the local roster for "${swarmId}". Check ${filePath} before retrying.`, { cause: error });
      }
    }
  } else {
    const existing = memoryStore.get(swarmId);
    if (existing) return existing;
  }
  return {
    swarm_id: swarmId,
    updated_at: new Date().toISOString(),
    members: Object.create(null),
  };
}

async function saveRoster(swarmId, roster) {
  roster.updated_at = new Date().toISOString();
  const filePath = rosterFilePath(swarmId);
  if (!filePath) {
    memoryStore.set(swarmId, roster);
    return;
  }

  const dir = join(process.env.PLUGIN_DATA, 'swarms');
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(roster, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    throw error;
  }
}

function emptyUsage() {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
}

function addUsage(acc, delta) {
  const base = acc ? { ...emptyUsage(), ...acc } : emptyUsage();
  if (!delta || typeof delta !== 'object') return base;
  if (typeof delta.input_tokens === 'number') base.input_tokens += delta.input_tokens;
  if (typeof delta.cached_input_tokens === 'number') base.cached_input_tokens += delta.cached_input_tokens;
  if (typeof delta.output_tokens === 'number') base.output_tokens += delta.output_tokens;
  return base;
}

export function bindMember(swarmId, { member, sandbox, model, reasoningEffort, workspace, forkFrom }) {
  const id = normalizeSwarmId(swarmId);
  validateMemberName(member);
  if (!VALID_SANDBOXES.has(sandbox)) {
    throw new Error('Specify sandbox as "workspace-write" or "read-only" when binding a Swarm member.');
  }

  return withSwarmLock(id, async () => {
    const roster = await loadRoster(id);
    const prev = roster.members[member];
    let pendingForkSessionId;
    if (forkFrom) {
      if (UUID_RE.test(forkFrom)) {
        pendingForkSessionId = forkFrom;
      } else {
        const source = roster.members[forkFrom];
        if (!source) {
          throw new Error(`Cannot fork from unknown member "${forkFrom}" in swarm "${id}".`);
        }
        if (!source.session_id) {
          throw new Error(`Member "${forkFrom}" must complete at least one turn before its Codex session can be forked.`);
        }
        pendingForkSessionId = source.session_id;
      }
    }

    const keepExistingSession = prev && !prev.released && !pendingForkSessionId;
    roster.members[member] = {
      sandbox,
      model: model ?? null,
      reasoning_effort: reasoningEffort ?? null,
      workspace: workspace ?? prev?.workspace ?? null,
      session_id: keepExistingSession ? (prev.session_id ?? null) : null,
      pending_fork_session_id: pendingForkSessionId ?? null,
      turns_completed: keepExistingSession ? (prev.turns_completed ?? 0) : 0,
      total_usage: keepExistingSession ? addUsage(prev.total_usage) : emptyUsage(),
      last_turn_at: keepExistingSession ? (prev.last_turn_at ?? null) : null,
      last_files_modified: keepExistingSession ? (prev.last_files_modified ?? []) : [],
      released: false,
      released_at: null,
      updated_at: new Date().toISOString(),
    };
    await saveRoster(id, roster);
    return {
      swarm_id: id,
      member,
      ...roster.members[member],
    };
  });
}

export function configureMember(swarmId, { member, model, reasoningEffort, sandbox }, isRunning) {
  const id = normalizeSwarmId(swarmId);
  validateMemberName(member);

  return withSwarmLock(id, async () => {
    if (isRunning) {
      throw new Error(`Member "${member}" is currently running a turn. Wait for it to finish before reconfiguring.`);
    }
    const roster = await loadRoster(id);
    const entry = roster.members[member];
    if (!entry) {
      throw new Error(`Unknown member "${member}" in swarm "${id}". Bind it first.`);
    }
    if (entry.released) {
      throw new Error(`Member "${member}" was released. Bind a new worker name instead.`);
    }
    if (model !== undefined) entry.model = model === '' ? null : model;
    if (reasoningEffort !== undefined) entry.reasoning_effort = reasoningEffort;
    if (sandbox !== undefined) {
      if (!VALID_SANDBOXES.has(sandbox)) {
        throw new Error('Invalid sandbox. Use "workspace-write" or "read-only".');
      }
      entry.sandbox = sandbox;
    }
    entry.updated_at = new Date().toISOString();
    await saveRoster(id, roster);
    return {
      swarm_id: id,
      member,
      ...entry,
    };
  });
}

export function prepareMemberTurn(swarmId, { member, workspace, model, reasoningEffort, sandbox, forkFromSessionId }) {
  const id = normalizeSwarmId(swarmId);
  validateMemberName(member);

  return withSwarmLock(id, async () => {
    const roster = await loadRoster(id);
    let entry = roster.members[member];
    if (entry?.released) {
      throw new Error(`Member "${member}" was released; bind a new worker name.`);
    }
    const boundSandbox = entry?.sandbox ?? 'read-only';
    if (sandbox === 'workspace-write' && boundSandbox !== 'workspace-write') {
      throw new Error(`Bind member "${member}" with sandbox "workspace-write" before requesting a writable turn.`);
    }
    if (boundSandbox === 'workspace-write' && entry.workspace && entry.workspace !== workspace) {
      throw new Error(`Member "${member}" is bound to a different workspace. Rebind it before changing workspaces.`);
    }
    if (!entry) {
      entry = {
        sandbox: 'read-only',
        model: model ?? null,
        reasoning_effort: reasoningEffort ?? null,
        workspace,
        session_id: null,
        pending_fork_session_id: forkFromSessionId ?? null,
        turns_completed: 0,
        total_usage: emptyUsage(),
        last_turn_at: null,
        last_files_modified: [],
        released: false,
        released_at: null,
        updated_at: new Date().toISOString(),
      };
      roster.members[member] = entry;
    } else {
      entry.workspace = workspace;
      if (model !== undefined) entry.model = model;
      if (reasoningEffort !== undefined) entry.reasoning_effort = reasoningEffort;
      if (forkFromSessionId && !entry.session_id) {
        entry.pending_fork_session_id = forkFromSessionId;
      }
      entry.updated_at = new Date().toISOString();
    }

    await saveRoster(id, roster);
    return {
      model: entry.model ?? undefined,
      reasoning_effort: entry.reasoning_effort ?? undefined,
      sandbox: sandbox ?? boundSandbox,
      session_id: entry.session_id ?? undefined,
      pending_fork_session_id: entry.pending_fork_session_id ?? undefined,
    };
  });
}

export function completeMemberTurn(swarmId, member, outcome) {
  const id = normalizeSwarmId(swarmId);
  return withSwarmLock(id, async () => {
    const roster = await loadRoster(id);
    const entry = roster.members[member];
    if (!entry || entry.released) return null;

    if (outcome.status === 'completed') {
      entry.session_id = outcome.session_id;
      entry.pending_fork_session_id = null;
      entry.turns_completed = (entry.turns_completed ?? 0) + 1;
      entry.total_usage = addUsage(entry.total_usage, outcome.usage);
      entry.last_turn_at = new Date().toISOString();
      entry.last_files_modified = outcome.inspected?.files_modified ?? [];
      entry.updated_at = entry.last_turn_at;
      await saveRoster(id, roster);
    }
    return {
      turns_completed: entry.turns_completed,
      total_usage: entry.total_usage,
    };
  });
}

export function releaseMember(swarmId, member) {
  const id = normalizeSwarmId(swarmId);
  validateMemberName(member);

  return withSwarmLock(id, async () => {
    const roster = await loadRoster(id);
    const entry = roster.members[member];
    if (!entry) {
      return { swarm_id: id, member, released: true, existed: false };
    }
    entry.released = true;
    entry.released_at = new Date().toISOString();
    entry.updated_at = entry.released_at;
    await saveRoster(id, roster);
    return {
      swarm_id: id,
      member,
      existed: true,
      ...entry,
    };
  });
}

export function getSwarmStatus(swarmId, activeRunKeys) {
  const id = normalizeSwarmId(swarmId);
  return withSwarmLock(id, async () => {
    const roster = await loadRoster(id);
    const members = Object.entries(roster.members)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, m]) => {
        const state = m.released
          ? 'released'
          : activeRunKeys.has(`${id}:${name}`)
            ? 'running'
            : 'ready';
        return {
          member: name,
          state,
          sandbox: m.sandbox,
          model: m.model,
          reasoning_effort: m.reasoning_effort,
          session_id: m.session_id,
          pending_fork_session_id: m.pending_fork_session_id,
          turns_completed: m.turns_completed ?? 0,
          total_usage: m.total_usage ?? emptyUsage(),
          last_turn_at: m.last_turn_at ?? null,
          last_files_modified: m.last_files_modified ?? [],
          workspace: m.workspace ?? null,
        };
      });
    return {
      swarm_id: id,
      updated_at: roster.updated_at,
      members,
    };
  });
}
