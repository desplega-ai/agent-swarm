---
id: step-6
name: pre.tool.call + post.tool.call
depends_on: [step-2]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-6: pre.tool.call + post.tool.call

## Overview
After this step an enabled extension can inspect, rewrite, or reject any agent-facing MCP tool call before it runs, and observe the result after. Motivating example 2 (communication-style enforcement on `store-progress` / task completion / Slack output) passes as a fixture. Calls with `callOrigin` `script-sdk` or `extension` bypass both hooks (brainstorm Key Decisions).

## Changes Required:

#### 1. Pre-call hook in the registrar
**File**: `src/tools/utils.ts`
**Changes**: In `createToolRegistrar` (743-797), in both branches, after `requestInfo` is computed and inside the `withSpan` callback but before `cb(...)`: if `requestInfo.callOrigin === "mcp"`, call `dispatchPre("pre.tool.call", { tool: name, args, requestInfo })`. `block` → `outcome = toolErr(reason, { details: { blockedBy: extension } })` and skip `cb`. `modify` → replace `args` with `data.args` re-parsed through the tool's `inputSchema` (`config.inputSchema.safeParse`); a parse failure logs a warning, writes an `error` run row, and uses the original args. `continue` → unchanged. The no-input-schema branch (754) passes `args: {}` and ignores modify. Keep the dispatcher import lazy (`await import("../extensions/dispatcher")`) or otherwise confirm `src/tools/utils.ts` does not create an import cycle with `src/extensions/ctx.ts` (which imports the in-process tool invoker). Run `bun run check:dep-graph`.

#### 2. Post-call hook
**File**: `src/tools/utils.ts`
**Changes**: After `finalizeSwarmToolResult` (766 / 789) and only for `callOrigin === "mcp"`, `void dispatchPost("post.tool.call", { tool: name, args, result: outcome, requestInfo, durationMs })` where `durationMs` is measured around `cb`. Do not await it on the request path; `dispatchPost` never throws.

#### 3. Nudge on block
**File**: `src/tools/utils.ts` (`NUDGES` map, 243-296)
**Changes**: No per-tool entry. The block `toolErr` message already carries the reason; add one generic sentence via `details` so the agent knows an extension, not the tool, rejected the call. Do not add a new NUDGES key.

#### 4. Fixtures and tests
**File**: `src/tests/extensions-tool-call.test.ts` (new), `src/tests/fixtures/extensions/{no-exclamation-marks,rewrite-progress-prefix}.ts`, `src/tests/extensions-examples.test.ts`
**Changes**: Copy `src/tests/tool-registrar-no-input.test.ts` (real `McpServer`, tool registered through `createToolRegistrar`, invoked end-to-end). Register a scratch tool with an input schema plus the real `store-progress`. Cases: `no-exclamation-marks` blocks a `store-progress` whose `progress` text contains `!` and the wire result is `isError` with the reason and the extension name; a compliant call proceeds and a `post.tool.call` run row appears with `durationMs`; `rewrite-progress-prefix` modifies `args.progress` and the stored progress carries the prefix; a modify producing invalid args falls back to the original with an `error` run row; a call marked script-sdk (`markScriptSdkRequestOrigin`) and a call marked extension origin skip both hooks (no run rows); `swarm-tool-result-gate.test.ts` and `multi-runtime-registration.test.ts` stay green. Add example 2 to `extensions-examples.test.ts` using the `no-exclamation-marks` fixture against `store-progress`.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/extensions-tool-call.test.ts src/tests/extensions-examples.test.ts`
- [ ] `bun run test:root -- src/tests/tool-registrar-no-input.test.ts src/tests/swarm-tool-result-gate.test.ts src/tests/multi-runtime-registration.test.ts src/tests/scripts-mcp-e2e.test.ts`
- [ ] `bun run tsc:check && bun run lint && bun run check:dep-graph`
- [ ] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [ ] Boot on a scratch DB, enable `no-exclamation-marks`, run the MCP handshake from `LOCAL_TESTING.md` § Handshake sequence with a UUID agent id, call `store-progress` with `"done!"` and confirm the JSON-RPC result has `isError: true` and names the extension; call again with `"done."` and confirm success plus a `post.tool.call` run row.
- [ ] Run a scratch script through `script-run` that calls `ctx.swarm.storeProgress` with `"done!"` and confirm it is not blocked (script-sdk origin bypass).

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
