---
name: codex-delegate
description: >-
  Delegate a read-only workspace review, Git diff audit, root-cause diagnosis,
  or second opinion to local OpenAI Codex, or orchestrate ChatGPT Codex CLI
  builder/verifier workers inside Antigravity /swarm. Use when the user invokes
  /codex-delegate, asks for a Codex or GPT worker/review, or uses Codex in Swarm.
compatibility: Requires Node.js 22+ and a ChatGPT-authenticated local Codex CLI (codex login).
---

# Delegate to Codex

Bridge Antigravity with the ChatGPT-authenticated local OpenAI Codex CLI (API key env vars stripped, `--no-daemon`, external MCP/plugins/hooks/web-search disabled).

## Choose the Right Mode

1. **Swarm Hybrid Team (`/swarm` with ChatGPT Codex builders & verifiers)**:
   - Call `codex_swarm{ action: "models" }` to list ChatGPT Codex models, supported reasoning efforts (`low`..`ultra`), and rate limits.
   - Bind builders with `codex_swarm{ action: "bind", swarm_id, member, sandbox: "workspace-write", model, reasoning_effort }` and add them via `swarm{ action: "add", name: member, workspace: "share", ... }`.
   - Bind verifiers with `sandbox: "read-only"` and `workspace: "inherit"`.
   - Instruct each carrier worker to load `codex-swarm-worker` and call the eager `mcp_codex-delegate_worker_codex_swarm_turn` tool directly with the assignment in `prompt`. Retry a generic `call_mcp_tool` `not enabled` error using the direct tool. Use `codex_swarm` (`status`, `configure`, `release`) and `bind` (`fork_from`) to inspect, hot-swap models/efforts without losing `session_id`, fork sessions, or retire members.

2. **Subagent delegation (`codex-auditor`) — preferred for single-session or parallel read-only audits**:
   - Call `invoke_subagent` with `TypeName: "codex-auditor"`.
   - `codex-auditor` runs on a lightweight model in its own context, scopes files, invokes `codex_consult` / `codex_review`, verifies cited `file:line` references against local code, follows up on `session_id` if needed, and returns a verified summary + `session_id`.

3. **Direct MCP tools (`codex_consult` / `codex_review`)**:
   - **`codex_review`**: Native read-only Git review (`target`: `"uncommitted"`, `"base"` + `base`, `"commit"` + `commit`, or `"custom"` + `instructions`). Cannot combine `uncommitted`/`base`/`commit` with custom `instructions`; pass the returned `session_id` to `codex_consult` for targeted follow-ups.
   - **`codex_consult`**: Read-only analysis (`workspace`, `task`, optional `session_id` to resume across turns/restarts, `model`, `reasoning_effort` up to `ultra`, and `output_schema` JSON Schema).

## Execution Rules

- **Never poll**: `codex_consult`, `codex_review`, and `codex_swarm_turn` run with `"background": "always"` (`timeoutSeconds: 660`). End your turn after invoking them and wait for Antigravity's automatic wakeup notification. (`codex_swarm` runs in the foreground.)
- **Keep writes scoped to the builder's working copy**. Writable turns require an explicit `workspace-write` roster binding. If `bind` omits the directory, the first turn pins it. Use that same absolute directory on each turn, including a single-turn downgrade with `sandbox: "read-only"`. Standalone consults and reviews run read-only.
- **Honest attribution**: Attribute conclusions to Codex only after the tool completes, and surface the exact error message if Codex CLI is unavailable or fails.
