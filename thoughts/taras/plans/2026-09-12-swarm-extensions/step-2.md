---
id: step-2
name: "Runtime: loader, dispatcher, ctx, identity, post bridge"
depends_on: [step-1]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: Runtime: loader, dispatcher, ctx, identity, post bridge

## Overview
After this step an enabled extension actually runs. Enable creates the `ext:<name>` agent, imports the source in-process, and registers handlers. The dispatcher runs `pre.*` chains by priority with the 5 s cap, fail-open, failure counter, auto-disable, and run log. `post.task.*` and `post.slack.message` reach handlers from the existing bus. Boot loads every enabled extension. No boundary emits a `pre.*` event yet; a `post.task.created` handler is the QA proof. Read the brainstorm's Key Decisions before starting.

## Changes Required:

#### 1. Transaction guard
**File**: `src/be/db-client.ts`
**Changes**: Export `isInTransaction(): boolean` returning `txContext.getStore() !== undefined && !store.closed` (`txContext` at line 139). One-line addition, keep `txContext` private.

#### 2. Identity
**File**: `src/extensions/identity.ts` (new)
**Changes**: `ensureExtensionAgent(name)` finds or creates an agent row named `ext:<name>` with `role: "extension"`, `status: "offline"`, `isLead: 0`, `maxTasks: 0`, description "System agent for extension <name>". Use the existing agent-creation DB function (find it in `src/be/db.ts`, the one `join-swarm` uses); do not insert raw SQL. Returns the agent id, stored on `extensions.agentId`. `deactivateExtensionAgent(name)` leaves the row and sets `status: "offline"` (already offline; this is a no-op placeholder so disable has a symmetric call).

#### 3. Loader
**File**: `src/extensions/loader.ts` (new)
**Changes**: `loadExtension(record): Promise<LoadedExtension>`:
- Directory `${os.tmpdir()}/swarm-extensions/<name>/`; write `<name>-<contentHash>.ts`; write bare-import shims for `zod`, `stdlib`, and `swarm-extension` with `writeBareImportShim` from `src/scripts-runtime/executors/native.ts:93` (export it, or move it to `src/scripts-runtime/bare-import-shim.ts` and import from both). The `swarm-extension` shim re-exports `src/extensions/contract.ts` runtime helpers (`block`, `modify`); in the compiled binary point it at a pre-bundled `extensions-contract.bundle.js` staged like `zod.bundle.js` in the Dockerfile (lines 25-46), resolved via the same `runtimeDir` logic as `native.ts:110`.
- `const mod = await import(filePath)`; validate `mod.manifest` and `typeof mod.default === "function"`; build an `ExtensionApi` whose `on(event, handler, opts)` pushes `{ event, handler, priority: opts?.priority ?? record.priority }` into a local array; call `mod.default(api)`; return `{ record, handlers, dispose }` where `dispose` removes the source file.
- Delete the previous hash-named file for the same name after a successful import. Clean the whole directory at boot before loading.
- Any throw here is a `load-error`: write an `extension_runs` row, set `status: "error"`, `lastError`, and do not register handlers.

#### 4. Dispatcher
**File**: `src/extensions/dispatcher.ts` (new)
**Changes**:
- Registry `Map<extensionId, LoadedExtension>`; `registerLoaded`, `unregister`, `listRegistered`.
- `dispatchPre<E>(event: E, payload: SwarmEventMap[E]["event"], opts?: { skipExtensionId? }): Promise<{ action: "continue" } | { action: "modify"; data } | { action: "block"; reason; extension }>`: if `isInTransaction()` log a violation with `console.error("[extensions] pre dispatch inside transaction:", event)` and return continue. Collect handlers for `event` across registered extensions, sort by `priority` ascending then extension name, run sequentially. Each handler gets `(currentPayload, ctx)` where `ctx` comes from `buildCtx` (below) with `ctx.signal` from an `AbortController` that fires at `EXTENSION_HANDLER_TIMEOUT_MS` (5000, env-overridable). `Promise.race` against the timeout. `modify` results are merged into `currentPayload` per event (the boundary in later steps re-validates). First `block` returns immediately. Throw or timeout: write an `extension_runs` row with `action: "error" | "timeout"`, increment `consecutiveFailures`, and if it reaches `EXTENSION_MAX_CONSECUTIVE_FAILURES` (5) set `status: "auto-disabled"`, `enabled: 0`, and `unregister`. A successful handler resets the counter to 0. Every run writes an `extension_runs` row (`continue` / `modify` / `block`) with `durationMs`.
- `dispatchPost(event, payload)`: same ordering and cap, results ignored, never throws, runs with `void` semantics (fire-and-forget from the caller's point of view; internally awaited sequentially so the log is ordered).
- `opts.skipExtensionId` implements the self-recursion rule from the brainstorm.

#### 5. ctx
**File**: `src/extensions/ctx.ts` (new)
**Changes**: `buildCtx(loaded, eventName)` returns `ApiCtx`: `swarm` = an object with the same method surface as the scripts SDK (`src/scripts-runtime/swarm-sdk.ts` method names via `SDK_TOOL_NAME_MAP`) that invokes MCP tools in-process. Reuse the in-process invocation that `handleMcpBridge` in `src/http/mcp-bridge.ts:103` performs: extract `invokeToolInProcess({ toolName, args, agentId, sourceTaskId, callOrigin })` if it is not already a standalone function, and extend `RequestInfo.callOrigin` in `src/tools/utils.ts:39` with `"extension"` plus a `markExtensionRequestOrigin` sibling of `markScriptSdkRequestOrigin` (line 27). `ctxControlMiddleware` (line 586) must treat `"extension"` like `"script-sdk"`. `state` = `get/set/incr/del` over the KV tools namespaced `ext:<name>:`. `config` = `configJson` parsed and validated against `manifest.config` (fail enable with a 400-style error on mismatch). `log` = `{ info, warn, error }` writing `console.*` with `scrubSecrets` and an `extension_runs` row only for `error`. `signal`, `event` as in the brainstorm Types.

#### 6. Post bridge
**File**: `src/extensions/post-bridge.ts` (new)
**Changes**: Copy `src/linear/outbound.ts:44-66`: subscribe once to `task.created`, `task.completed`, `task.failed`, `task.cancelled`, `task.superseded`, `task.progress`, `slack.message` on `workflowEventBus`; each handler maps the bus payload to the `post.*` payload (load the full task row by `taskId` with the existing getter so handlers receive `task`, not just ids) and calls `dispatchPost`. Wrap in the `observed()` try/catch pattern. `post.tool.call` is step-6.

#### 7. Lifecycle and boot
**File**: `src/extensions/lifecycle.ts` (new), `src/http/index.ts`, `src/http/extensions.ts`
**Changes**: `enableExtension(id, { by })`: validate config, `ensureExtensionAgent`, `loadExtension`, `registerLoaded`, `setExtensionState({ enabled: 1, status: "enabled", consecutiveFailures: 0, lastError: null })`. `disableExtension(id)`: `unregister`, `dispose`, `setExtensionState({ enabled: 0, status: "disabled" })`. `activateVersion(id, version)`: copy that version's source into `extensions.source/contentHash/activeVersion`, then if enabled, disable + enable. `reloadExtension(id)` used by upsert with `{ activate: true }`. `loadEnabledExtensions()` at boot: clean the tmp dir, load every `enabled = 1` row, an individual failure marks that row `error` and continues. Insert the boot call right after `runAllSeeders` in `src/http/index.ts:599-601`, before `httpServer.listen` (621). Start a 30 s `setInterval` poll comparing `max(updatedAt)` of enabled rows to the registry and reloading changed ones (multi-replica mitigation); clear it on shutdown next to the other intervals. Fill the enable / disable / activate-version 501 stubs from step-1 with these functions.

#### 8. Tests
**File**: `src/tests/extensions-loader.test.ts`, `src/tests/extensions-dispatcher.test.ts`, `src/tests/extensions-lifecycle.test.ts` (new), fixtures `src/tests/fixtures/extensions/{post-logger,throws,slow,priority-a,priority-b}.ts`
**Changes**: Loader: imports a fixture, exposes handlers, rejects a file without default export, cleans old hash files. Dispatcher: priority order across two extensions; modify chaining; first block wins; throw counts as continue and writes an `error` run; 5 consecutive throws auto-disable (set the cap via env to keep the test fast, and the timeout to 50 ms for the `slow` fixture); `isInTransaction()` guard returns continue and logs; `skipExtensionId` skips. Lifecycle: enable creates `ext:<name>` agent with `status: "offline"`; disable unregisters; activate-version swaps source and reloads; boot loads only enabled rows and survives one load-error. Post bridge: create a task with `createTaskExtended` and assert the `post-logger` fixture wrote an `extension_runs` row.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/extensions-loader.test.ts src/tests/extensions-dispatcher.test.ts src/tests/extensions-lifecycle.test.ts`
- [ ] `bun run test:root -- src/tests/extensions-http.test.ts` still green (enable / disable / activate now real)
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`
- [ ] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] `bun run docker:build:api`

#### Automated QA:
- [ ] Boot the API on a scratch DB, upsert `post-logger`, enable it, confirm `GET /api/agents` lists `ext:post-logger` with `status: "offline"`, `POST /api/tasks`, then `GET /api/extensions/{id}/runs` shows a `post.task.created` row with `action: "continue"`.
- [ ] Upsert `throws`, enable, create 5 tasks, confirm `status: "auto-disabled"` and `consecutiveFailures: 5`; re-enable resets to 0.
- [ ] Compiled-binary smoke: `docker run --rm -e DATABASE_PATH=/tmp/x.sqlite agent-swarm-api:latest` boots, then the same upsert + enable + task flow via curl against the container succeeds (proves `import()` and the shims work in `/$bunfs` mode).
- [ ] Restart the API with the extension enabled and confirm it is loaded at boot (`GET /api/extensions/{id}` shows `status: "enabled"`, and a new task produces a run row).

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
