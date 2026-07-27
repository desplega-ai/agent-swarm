---
id: step-8
name: MCP tools (agent + user) + script SDK
depends_on: [step-1]
status: done
completed_at: 2026-07-27
---

# step-8: MCP `steer-task` (agent + user surfaces) + script SDK `task_steer`

## Overview

Exposes step-1's core steering service to agents (so a lead can steer its workers), to MCP users (the `/mcp-user` surface, RBAC-gated), and to scripts. All three call the same handler, following the `cancel-task` / `task-action` reference wirings exactly.

**This step owns `src/tools/steer-task.ts`, `src/server.ts`, `src/server-user.ts`, `src/be/scripts/typecheck.ts`, and the `SDK_TOOL_NAME_MAP` region of `sdk-allowlist.ts`.** step-3 separately owns `accept-steer` and the `EXCLUDED_TOOLS` region of the same file — keep edits disjoint.

## Changes Required:

#### 1. The tool
**File**: `src/tools/steer-task.ts` (new)
**Changes**: Copy the anatomy of `src/tools/cancel-task.ts`:

- **Input schema** (`cancel-task.ts:17-20` shape): `{ taskId: z.uuid(), message: z.string().min(1), mode: SteerModeSchema.default("queue"), onUnsupported: OnUnsupportedSchema }` — decision 14's explicit-with-queue-default plus decision 16's opt-in hard failure.
- **Output schema** (`:22-27` shape): `{ yourAgentId?, success, outcome, effectiveMode, degradedFrom?, steeringMessageId?, promotedTaskId?, message }`.
- **Tool description must state per-provider support** (decision 16) — e.g. *"`mode:"steer"` is honored on pi, devin, claude-managed and opencode; claude supports queue only; codex always falls back to a follow-up task. Pass `onUnsupported:"fail"` to get an error instead of a downgrade."* This is how a model learns the asymmetry without having to discover it from a degraded result.
- **Handler**: `async function steerTaskHandler(ctx: ToolCtx, args): Promise<CallToolResult>` (`:31-34`). Branch on `ctx.kind` exactly as cancel-task does:
  - `"owner"` (agent-side, `:74-90`): resolve the agent, load the task, call `can({ principal: { kind: "agent", agentId, isLead }, verb: "task.steer.any", resource: { kind: "task", taskId, creatorAgentId } })` — the lead-or-creator gate decision 7 asks for.
  - `"user"` (`:113-123`): `assertOwnsTask(ctx, task, "task.steer.own")` from `src/tools/task-tool-ctx.ts:28-59`.
- **Return**: two-item `content` array (human message, then JSON) plus `structuredContent` (`:160-169`). The human-readable line must state what actually happened, e.g. *"Queued for delivery (requested steer; claude supports queue only)."*
- **Registrar**: `registerSteerTaskTool` via `createToolRegistrar(server)` (`:172-185`), `annotations: { destructiveHint: true }`.

#### 2. Agent-surface registration
**File**: `src/server.ts`
**Changes**: Register in the **`task-pool`** capability block (`:341-343`, alongside `registerTaskActionTool`) — steering is a task-lifecycle mutation, same family as claim/release/accept/reject. `task-pool` is already in `DEFAULT_CAPABILITIES` (`:195-221`), so no edit there and no new entry in `ALL_CAPABILITIES` (`:167-190`).

#### 3. User-surface registration
**File**: `src/server-user.ts`
**Changes**: Follow the `cancelTaskConfig` block (`:150-162`) verbatim:

```ts
const steerTaskConfig = {
  title: "Steer Task",
  description: "Send a message to a task that is already running.",
  annotations: { destructiveHint: true },
  rbac: permission("task.steer.own"),
  inputSchema: steerTaskUserInputSchema,
  outputSchema: steerTaskOutputSchema,
};
registerTool("steer-task", steerTaskConfig, async (args, info, _meta) => {
  const denied = await maybeDenyUserToolAdmission(user, "steer-task", steerTaskConfig);
  if (denied) return denied;
  return steerTaskHandler(userCtx(user, info.sessionId), args);
});
```

`permission()` is at `:55-57`; `maybeDenyUserToolAdmission` at `:59-87`. Add the handler import to the top-of-file import block (mirroring `:13-17`).

#### 4. `ALL_TOOLS` + script SDK
**Files**: `src/tools/tool-config.ts`, `src/scripts-runtime/sdk-allowlist.ts`, `src/be/scripts/typecheck.ts`
**Changes**:

- Add `"steer-task"` to `ALL_TOOLS`. `cancel-task` sits in `DEFERRED_TOOLS` (`:192`) and `task-action` in `CORE_TOOLS` (`:22`) — put `steer-task` with `task-action` in `CORE_TOOLS` if it should be always-surfaced, otherwise `DEFERRED_TOOLS`. Prefer **`DEFERRED_TOOLS`**: steering is a lead-initiated action, not something most agents need in their default tool surface.
- `SDK_TOOL_NAME_MAP` (`sdk-allowlist.ts`), under the `// ── tasks ──` group (`:10-17`), next to `task_cancel: "cancel-task"` (`:16`):
  ```ts
  task_steer: "steer-task", // destructive
  ```
  Decision 8 — this goes in the map, **not** `EXCLUDED_TOOLS`.
- `SCRIPT_SDK_TYPES` in `src/be/scripts/typecheck.ts`, in the `// --- write: tasks ---` block next to `:137-139`:
  ```ts
  task_steer(args: { taskId: string; message: string; mode?: "steer" | "queue"; onUnsupported?: "degrade" | "fail" }): Promise<unknown>;
  ```
  This block is **hand-authored**. Then run `bun run build:script-types` and commit the regenerated `src/scripts-runtime/types/*.d.ts` — **never hand-edit those `.d.ts` files.**

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint`
- [ ] Tests pass: `bun test src/tests/steer-task-tool.test.ts` (new — cover: `mode` defaults to `queue` and `onUnsupported` defaults to `degrade` when omitted, agent-surface lead-or-creator gate allows a lead and denies an unrelated agent, user-surface admission denies without the grant, structured output carries `outcome`/`degradedFrom`, and `onUnsupported:"fail"` on an unsupported provider returns an error result rather than a degraded success)
- [ ] Script tests pass: `bun test src/tests/scripts-*.test.ts`
- [ ] Full suite green: `bun test`
- [ ] SDK tool registration passes: `bun run scripts/check-sdk-tool-registration.ts`
- [ ] RBAC coverage passes: `bun run check:rbac-coverage`
- [ ] Script types are fresh: `bun run build:script-types && git diff --exit-code src/scripts-runtime/types/`
- [ ] DB boundary holds: `bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Agent performs the full MCP handshake per LOCAL_TESTING.md § "MCP tool testing over HTTP" (initialize → notifications/initialized → tools/call, with `Authorization`, a **UUID** `X-Agent-ID`, and `Accept: application/json, text/event-stream`), calls `steer-task` on a running task, and shows the structured result
- [ ] Agent shows `steer-task` appears in `tools/list` when `task-pool` is enabled and is absent when `CAPABILITIES` excludes it
- [ ] Agent calls `steer-task` on the **user** surface (`/mcp-user`) and shows RBAC admission allowing the task creator and denying a non-creator
- [ ] Agent authors and runs a script calling `swarm.task_steer({ taskId, message, mode: "queue" })` via `script_run` and shows it succeeds and that `tsc --noEmit` accepts the typed signature (`script_upsert` typechecks against the generated `.d.ts`)

#### Manual Verification:
- [ ] Taras confirms `steer-task` belongs in `DEFERRED_TOOLS` rather than `CORE_TOOLS` (tool-surface budget call)

**Implementation Note**: Vertical slice — three caller surfaces over one handler, QA-able without any worker/provider work (the codex/promotion path proves the round trip). Commit `[step-8] steer-task MCP tools and task_steer script SDK method`.
