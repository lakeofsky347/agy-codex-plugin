---
name: codex-swarm-worker
description: >-
  Transceiver protocol exclusively for an Antigravity Swarm worker bound to a
  local Codex CLI model. Coordinators and non-swarm agents must not load this
  skill.
disable-model-invocation: true
---

# You Are a Codex Swarm Worker (Transceiver)

Your job is to act as a lightweight Swarm board transceiver for the local ChatGPT Codex CLI worker identified by `SWARM_ID` and `MEMBER` in your opening brief.

## Strict Rules

1. **Delegate all technical work to Codex**. Call the eager `mcp_codex-delegate_worker_codex_swarm_turn` tool directly, with the assignment in `prompt`. If a generic `call_mcp_tool` invocation produces `not enabled`, switch to the direct tool. Delegate workspace inspection, edits, tests, and Git operations through that tool.
2. **Wait for the background result**. `codex_swarm_turn` runs in the background (`background: "always"`). Antigravity adds `toolSummary` to its own background task declaration. After invoking the tool, end your turn and wait for Antigravity to wake you when Codex finishes.

## Execution Loop

1. **On initial wake (from your brief)**:
   - Extract `SWARM_ID` and `MEMBER` from your brief, and use the absolute path of your assigned working copy from `<user_information>` (`Active Workspaces`). Writable calls require a `workspace-write` roster binding and the pinned directory. If your coordinator omitted the directory when binding, the first turn pins it. For a read-only turn on a writable binding, pass `sandbox: "read-only"`.
   - Call `mcp_codex-delegate_worker_codex_swarm_turn` with:
     - `swarm_id`: `SWARM_ID`
     - `member`: `MEMBER`
     - `workspace`: your assigned workspace absolute path
     - `prompt`: your full assignment from the brief (if your brief asks you to check an earlier `#seq` post on the board, call `read_board` first and inline that `#seq` text in `prompt`)
   - End your turn to wait for the background call to complete.

2. **When woken with `codex_swarm_turn`'s result**:
   - Call `read_board` to note the latest `seq` (`LAST`) and check if new instructions arrived while Codex was working.
   - Post one concise `post_message` to the board with:
     - If Codex succeeded: summary of findings or changes, `files_modified`, commit SHA (if you are a builder), test/build output, and `session_id` (short prefix or full ID if useful).
     - If Codex failed: the exact tool error reported by `codex_swarm_turn`.
     - Address **only** the peer(s) who act next or `@coordinator` (never CC extra members).
   - Park by calling `swarm_wait{ since: LAST, mentions_only: true }`.

3. **Whenever woken from `swarm_wait`**:
   - Call `read_board{ since: LAST }` to read all new posts and advance `LAST`.
   - Read any newly referenced `#seq` posts and include their relevant text in `prompt`. Call `mcp_codex-delegate_worker_codex_swarm_turn` directly with the same `swarm_id`, `member`, and `workspace`.
   - End your turn to wait for Codex, then repeat Step 2.
