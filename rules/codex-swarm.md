---
trigger: model_decision
description: Activate when orchestrating an Antigravity /swarm that uses local OpenAI Codex or GPT models as builder/author or verifier workers, or when managing Codex models inside a swarm.
---

# Orchestrating ChatGPT Codex Models in Antigravity Swarm

Native `swarm{action:"models"}` lists only Antigravity cloud models. Do **not** pass local Codex/GPT model names to `swarm{action:"add", model:...}`, and do not tell the user Codex models are unavailable. Instead, manage ChatGPT-authenticated Codex CLI workers through `mcp_codex-delegate_worker_codex_swarm` paired with lightweight Antigravity Swarm carrier workers.

## Coordinator Workflow

1. **Discover available ChatGPT Codex models**:
   - Call `mcp_codex-delegate_worker_codex_swarm` with `{ "action": "models" }` to inspect ChatGPT-authenticated Codex models, supported reasoning efforts (`low`..`ultra`), and rate limits.
   - Use your own Conversation ID (from `<user_information>`) as `swarm_id`.

2. **Bind & spawn Builder / Author Codex workers (`workspace-write`)**:
   - Bind the worker in the Codex roster first:
     `codex_swarm{ action: "bind", swarm_id: "<conv_id>", member: "<name>", sandbox: "workspace-write", model: "<model>", reasoning_effort: "<effort>" }`
   - Add the matching Antigravity carrier worker with its own working copy (`workspace: "share"`), leaving `swarm`'s `model` parameter **unset**:
     `swarm{ action: "add", name: "<name>", workspace: "share", brief: "..." }`
   - Use the worker's actual assigned workspace as the binding directory if known. If the binding omits `workspace`, the first turn pins the actual directory. A writable member uses that same directory on every turn and can request `sandbox: "read-only"` for an individual turn.
   - In the brief, require the builder to commit verified changes on its assigned branch using the local Git identity and repository hooks. Ask for the commit SHA, changed files, and test output. Git can write shared repository metadata for a linked worktree, so keep edits and branch operations scoped to the assignment. Land the changes before removing the worker because removal deletes its working copy.

3. **Bind & spawn Verifier / Auditor Codex workers (`read-only`)**:
   - Bind with `sandbox: "read-only"` and add with `workspace: "inherit"`.

4. **Required opening lines for every Codex worker's `brief`**:
   ```text
   You are a Codex Swarm Worker (SWARM_ID=<conv_id>, MEMBER=<name>).
   Load codex-swarm-worker, then call mcp_codex-delegate_worker_codex_swarm_turn directly with the assignment in prompt.
   ```
   Follow with the exact file or directory ownership, test and build criteria, and which peer to mention when done. The fully qualified tool is eager-loaded. A `not enabled` error from generic `call_mcp_tool` does not report the status of the direct tool.

5. **Manage lifecycle & hot-swap models**:
   - **Inspect**: `codex_swarm{ action: "status", swarm_id: "<conv_id>" }` shows each member's bound Codex model, reasoning effort, live state, `session_id`, and cumulative token usage.
   - **Switch model / effort mid-swarm**: When a worker is waiting (`status` is not `running`), call `codex_swarm{ action: "configure", swarm_id: "<conv_id>", member: "<name>", model: "...", reasoning_effort: "..." }` — this preserves the worker's Codex `session_id` context on the next turn.
   - **Fork warm context**: Call `codex_swarm{ action: "bind", swarm_id: "<conv_id>", member: "<new_name>", sandbox: "...", fork_from: "<existing_member>" }` before `swarm{ action: "add", name: "<new_name>", ... }` so the new worker branches directly from the existing Codex session via `codex exec fork`.
   - **Retire**: Call `codex_swarm{ action: "release", swarm_id: "<conv_id>", member: "<name>" }` alongside `swarm{ action: "kill", name: "<name>" }`.
