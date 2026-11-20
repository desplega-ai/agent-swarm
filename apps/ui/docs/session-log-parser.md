# Session log parser runbook

Moved from `apps/ui/CLAUDE.md`, which keeps the rule that causes damage when missed and a pointer here. Paths are relative to `apps/ui/` unless a line says repo root.

<!-- Applies when you are modifying session log parsing, task-detail logs, SessionLogViewer, or files under src/logs-parser. -->

- Parser ownership lives in `src/logs-parser/`. Keep harness-specific logic inside adapters; `components/shared/session-log-viewer.tsx` should render normalized messages, not parse raw provider protocols.
- Preserve the shared spine: parse `record.content` → order by `(createdAt, lineNumber, fileIndex)` → dispatch by `record.cli` → normalize to IR → pair tool calls/results → render. OpenCode delta reassembly depends on ordering before the adapter.
- Adapter boundaries:
  - `claude` / `pi`: Anthropic-style `message.content[]`; pair tool results by `tool_use_id`.
  - `claude-managed`: Anthropic Managed Agents raw SSE (`agent.message`, `agent.tool_use`, `agent.tool_result`, `session.status_*`); pair by managed tool ids and render non-message runtime events low-key.
  - `codex`: `item.started` is the call and `item.completed` is the result; pair by `item.id`.
  - `opencode`: concatenate `message.part.delta` by ordered `partID`; use `message.part.updated` only to learn part kind; pair `tool_start` / `tool_end` by `toolCallId`; drop `server.*` transport noise.
  - `devin`: provider-meta status / structured-output rows plus generic transcript messages; keep it on the generic path unless real fixtures prove a new adapter is needed.
- Internal/helper rows should use the compact low-key system presentation. Do not render provider-prefixed labels like `Claude helper` / `Opencode unknown`; show the event name or useful content only.
- Group Claude hook rows by `hook_event`, then by `hook_id`. Group continuous thinking-token rows into one helper line: live shimmer while running, otherwise `Thought for ...` with estimated thinking tokens.
- Validate with `bun test src/tests/ui-logs-parser.test.ts`, `cd apps/ui && bunx tsc -b`, and `cd apps/ui && bun run lint`. When touching OpenCode or Pi behavior, also run the parser against a real exported fixture and confirm zero unexpected `unknown` rows, no rendered `server.*` events, and no orphaned tool pairs.
