---
date: 2026-11-17
planner: Claude
topic: "Durable-object scripts, PR 1 (core)"
status: completed
autonomy: critical
commit_per_phase: true
last_updated: 2026-11-17
last_updated_by: Claude
---

# Durable-object scripts, PR 1 (core) Implementation Plan

## Overview

Add a second saved-script kind. A global script whose default export is `class X extends DurableObject<State>` defines named, single-writer objects. Each object keeps a JSON state snapshot in KV. Callers reach it through the existing `script_run` with a new `object: { id, method }` field.

- **Motivation**: prod swarm agents keep state between runs in KV by hand, with races and boilerplate. Taras asked for a Cloudflare-Durable-Object-like primitive built on scripts.
- **Related**:
  - Brainstorm (Synthesis is authoritative, Core Requirements 1-8 are this PR): [2026-11-17-durable-script-objects.md](../brainstorms/2026-11-17-durable-script-objects.md)
  - Research (as-is code map): [2026-11-17-durable-script-objects.md](../research/2026-11-17-durable-script-objects.md)
  - Planning spikes (exact edit points): [2026-11-17-durable-objects-pr1-spikes.md](../research/2026-11-17-durable-objects-pr1-spikes.md)

## Current State Analysis

**Executors accept only a default function.**
- Native: `eval-harness.ts:131-169` checks `typeof mod.default === "function"`, calls `mod.default(validatedArgs, ctx)`, and writes `JSON.stringify(result ?? null)` to the result file.
- QuickJS: the epilogue does the same, at `quickjs-prelude.ts:574-612`.
- A class passes the `typeof` check, but a call without `new` throws.

**Per-run inputs.**
- `SwarmConfigPayload` (`executors/types.ts:16-43`) reaches both executors unchanged: native stdin at `native.ts:535`, QuickJS `job.configPayload` at `quickjs.ts:206`. It is the only channel identical across both.
- `ExecutorInput` (`types.ts:55-73`) carries per-run flags such as `hostValidatedArgs`.
- `loader.ts:202-204` scrubs `output.result` after the run. State must not ride inside `result`, or it is scrubbed before commit.

**SDK imports.**
- Natively, `swarm-sdk` resolves through shim packages (`native.ts:157-213`, dev and compiled tables). The same mapping is repeated in `extract-args-schema.ts:23-26` and `src/extensions/loader.ts:58`.
- QuickJS uses a virtual module string, `SWARM_SDK_MODULE` (`quickjs-bundle.ts:30-33,117-123`). Precedent for a guest global: `define("__swarm_ctx", ctx)` (`quickjs-prelude.ts:468-469`).

**Typecheck and signature.**
- `ScriptMain` (`typecheck.ts:936`) is checked by an appended `const _scriptMain: ScriptMain = run` (`:1597-1607`).
- `extract-signature.ts:50-81` reads only default functions. It stores `signatureJson` via `signatureJsonFor` (`http/scripts.ts:602-604`).
- Other signature callers: seed scripts (`seed-scripts/index.ts:471`), dir import (`be/import/dir-source.ts:293`), extension assets (`be/extensions/assets.ts:336`).

**Run route.**
- `runBodySchema` is at `http/scripts.ts:77-90`, and `runRoute` at `:262-283`.
- The handler (`:754-940`) resolves agent scope first (`resolveScript`, `:606-617`). It then runs `runScriptWithRunCredential` with provenance `{ sourceScriptRunId: runId, sourceStepId }` (`:816-840`), records an inline row (`:915-929`), and responds with `scriptRunResponseSchema` (`:167-204`).
- The MCP tool (`tools/script-run.ts:55-93`) and the SDK (`swarm-sdk.ts:247`) forward the body verbatim.
- The SDK typing of `script_run` is hand-written at `typecheck.ts:480`.

**Provenance.**
- `session_tokens` (rebuilt in 232) gained `scriptRun` (233) and `sourceStepId` / `sourceScriptRunId` (293).
- `mintScriptRunToken` (`users.ts:746-771`) writes provenance with an UPDATE.
- Resolution (`users.ts:1050-1119`) feeds `HttpRequestAuth` (`request-auth-context.ts:30`) and `getCurrentRunProvenance()` (`:108-121`).
- No depth or recursion guard exists for scripts. The closest one is `MAX_SUB_WORKFLOW_DEPTH = 16` in `workflows/executors/sub-workflow.ts:33`.

**KV.**
- `claimKv` (`db.ts:14053-14075`) inserts if the key is absent, or overwrites only an expired row.
- `getKv`, `upsertKv` and `deleteKv` join an open `getDbClient().transaction` through AsyncLocalStorage (`db-client.ts:181`).
- `RESERVED_FAMILIES` (`kv-reserved-namespaces.ts:7-29`) blocks writes on the tool path (`tools/kv/kv-write-auth.ts:29`) and the HTTP path (`http/kv.ts:373`).
- Reads go through `tools/kv/kv-read-auth.ts:10-15` and `http/kv.ts:421-428`, with no scrubbing.

**Permissions.** Any agent may run any global script. No per-script run check exists (`http/scripts.ts:589-617`).

**Migrations.**
- `main`'s tail is `344_user_avatar.sql`. This branch is 23 commits behind `main`.
- Open PRs claim `343_tool_call_intents` (#3209), `344_page_kit` (#3264), and `310` / `311` (#2896).

**E2E.**
- Scripts occupy order band 400-499, and 490-499 is free.
- Helpers are in `scripts/e2e/scenarios/script-helpers.ts`. Every scenario needs a `flows` entry in `coverage-manifest.json`.
- A changed field on an existing route needs no manifest change.
- `src/be/` and `src/scripts-runtime/` edits trigger a full E2E run in `check:local`.

## Desired End State

An agent upserts this global script:

```ts
import { DurableObject } from "swarm-sdk";
export default class Counter extends DurableObject<{ n: number }> {
  initialState() { return { n: 0 }; }
  async add(args: { by: number }) { this.state.n += args.by; return this.state.n; }
}
```

Then:
- `script_run({ name: "counter", object: { id: "a", method: "add" }, args: { by: 2 } })` returns `2`. A second call returns `4`. Five concurrent calls to the same id end at a total that counts every call. Calls to id `b` start from `0`.
- The state survives an API restart. A thrown error leaves the state unchanged.
- Calling `initialState` or `_x` is refused before any lease is taken.
- A method that calls its own object through `ctx.swarm.script_run` fails at once with a re-entry error. A plain script chain deeper than 16 fails.
- `kv_get({ namespace: "durable:<scriptId>", key: "state/a" })` shows the state, scrubbed. `kv_set` on that namespace is refused.
- Both executors (`native`, `quickjs`) behave the same.
- Upserting the class in agent scope is refused.

Verify with `bun run e2e --only script-durable-objects` plus the gates in Quick Verification Reference.

## What We're NOT Doing

- **Out of PR 1:**
  - Schedules, workflow nodes and `onComplete`: PR 2.
  - `ctx.durable` typed sugar, App actions and the camelCase collision check: PR 3.
  - Pages, HTTP endpoints, `static exposed`, the realtime feed and rate limits: PR 4.
  - Extensions: later.
- **Deferred designs:** multi-key storage, read-only methods without a lease, a lease heartbeat, fair queueing, an outbox and agent-scope object scripts.
- **Downgrade check:** no "stored `codeVersion` newer than running code" check. In PR 1 every call runs the latest version, so the case cannot happen. It lands in PR 2 together with `pinHash` workflow nodes.
- **`ctx.caller` kinds:** only `agent` and `script` are produced. Other kinds arrive with their call sites.
- **No new MCP tool, HTTP route or unit test file.**

## Implementation Approach

- **The host owns state.** A new API-side module `src/be/scripts/durable.ts` loads state, takes and waits for the lease, and commits. The guest only receives `{ state, codeVersion, storedCodeVersion, method, id, caller }` and returns `{ result, state, destroyed, idleTtlSec }`.
- **One channel into the guest:** a new optional `durable` field on `SwarmConfigPayload`. It arrives on stdin natively and in the init snippet in QuickJS. One channel out: an envelope that each executor unpacks into a new `ExecutorOutput.durable` field before `loader.ts` scrubs `result`.
- **One runtime base class.** It is defined as plain JS in one exported string. Native `swarm-sdk.ts` evaluates or exports it, and the QuickJS `SWARM_SDK_MODULE` embeds the same text, so the two cannot drift.
- **Lease = `claimKv` on `lease/<id>`.** The value is a random token, and the TTL is the method wall clock + 10 s. Waiting polls with jittered backoff. The cap is 30 s for a top-level call and 5 s for a nested call, because the API cannot see a nested caller's remaining wall clock, and a short cap keeps the caller alive.
  - **Deviation from the brainstorm, noted:** the brainstorm said "bounded by the caller's remaining wall clock". The API has no way to know that, so the plan uses a fixed nested cap.
- **One commit transaction:** token check, then a state upsert (or a delete on destroy), then a lease delete. Unchanged state only refreshes `expires_at`.
- **Re-entry and depth** ride on `session_tokens.objectChain` + `depth` (one migration, which also adds the `script_runs` object columns). They are inherited through the existing provenance path in `/api/scripts/run`.
- **Sequencing:** runtime kind first (reachable only through upsert and validation), then the storage engine plus migration, then the `script_run` wiring with e2e, then docs. Every phase ends green on the existing script scenarios.

## Quick Verification Reference

- Types: `bun run tsc:check` (inner loop), `bun run tsc:check:tsc` (CI authority)
- Lint: `bun run lint`, `bun run lint:slop`
- Async-seam safety: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- Boundaries: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh && bash scripts/check-async-db-seam.sh`
- Generators: `bun run build:script-types`, `bun run docs:openapi`, `bun run build:skill-md` (commit the outputs)
- Gates: `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun scripts/check-sdk-tool-registration.ts && bash scripts/check-migration-conflicts.sh`
- E2E: `bun run e2e --only script-durable-objects`, then `bun run e2e --only script-inline-run,script-saved-lifecycle,script-sdk-calls,script-kv,script-limits`
- Inner loop: `bun run check:local`

---

## Phase 0: Rebase onto main

### Overview

The branch sits on current `main`, so migration numbering and spike line refs are checked against the real tail. Deliverable: a rebased branch with green typecheck.

### Changes Required:

#### 1. Rebase
**File**: (git only)
**Changes**: Rebase `t3/brainstorm-durable-script-worker` onto `origin/main` (23 commits behind at planning time). Re-check the spike line refs in the files this plan touches. Small shifts are expected. Record big ones in the Appendix derail notes.

### Success Criteria:

#### Automated Verification:
- [x] Rebased: `git fetch origin main && git rebase origin/main && git rev-list --count HEAD..origin/main` prints `0`
- [x] Types pass: `bun run tsc:check`
- [x] Migration tail known (345_task_status_kind; open claims 346, 347; chosen 348, renumbered to 354 after main took 348 and open PRs claimed 349-353): `git ls-tree --name-only origin/main src/be/migrations/ | grep '\.sql$' | sort | tail -1`

#### Automated QA:
- [x] Open-PR migration claims listed: `gh pr list --repo desplega-ai/agent-swarm --state open --limit 100 --json number,files --jq '.[] | {n:.number, m:[.files[].path | select(startswith("src/be/migrations/"))]} | select(.m|length>0)'`. Pick the next ordinal above both `main`'s tail and every open claim (345 or higher at planning time).

#### Manual Verification:
- [ ] None.

**Implementation Note**: No commit for this phase (a rebase only).

---

## Phase 1: DurableObject runtime kind (both executors, upsert)

### Overview

Deliverable: a global script that default-exports a `DurableObject` subclass can be upserted and typechecked, and its method allowlist appears in `signatureJson`. Both executors can run one method call when the host passes a `durable` payload. Nothing calls them yet except a guarded internal path.

### Changes Required:

#### 1. Shared base class
**File**: `src/scripts-runtime/durable-object-base.ts` (new)
**Changes**:
- Export `DURABLE_OBJECT_BASE_JS`, a plain-JS string with `class DurableObject { constructor(id) {...}; get id(); state; destroy() }`.
- Export the reserved method set: `constructor`, `initialState`, `migrate`, `destroy`, `_*`, plus statics.
- The base marks itself with `static __swarmDurable = true` so detection works without `instanceof` across module copies.

#### 2. Runtime exports
**Files**:
- `src/scripts-runtime/swarm-sdk.ts`
- `src/scripts-runtime/executors/quickjs-bundle.ts`
- `src/scripts-runtime/executors/native.ts` (shim tables at `:172-194`)

**Changes**:
- Export `DurableObject` from `swarm-sdk.ts`, built from the shared string.
- Append the same string plus `export { DurableObject }` to `SWARM_SDK_MODULE` (`:30-33`).
- Check that the compiled `swarm-sdk.bundle.js` build includes the new export. Find the bundle build step from `native.ts:189-194`.

#### 3. Epilogue dispatch
**Files**:
- `src/scripts-runtime/eval-harness.ts` (`:131-169`)
- `src/scripts-runtime/executors/quickjs-prelude.ts` (`:574-612`)
- `src/scripts-runtime/executors/quickjs-runner.ts` (init snippet `:675`, result `:656-699`)

**Changes**:
- If `payload.durable` is present, require `mod.default?.__swarmDurable`. Otherwise error with "this script is a DurableObject. Call it with object: { id, method }", or the reverse message.
- Then:
  1. `const obj = new mod.default(durable.id)`.
  2. Set `obj.state` = `durable.state`, or `await obj.initialState()` if absent.
  3. If `storedCodeVersion < codeVersion` and `obj.migrate` exists, set `obj.state = await obj.migrate(obj.state, storedCodeVersion)`.
  4. Refuse reserved or missing method names.
  5. `result = await obj[method](args, ctx)`.
- Write the envelope `{ __swarmDurable: 1, result, state: obj.state, destroyed, idleTtlSec: mod.default.idleTtlSec ?? null }`.
- QuickJS reads `durable` from a new `__swarm_durable` init global.

#### 4. Executor contract
**Files**:
- `src/scripts-runtime/executors/types.ts` (`SwarmConfigPayload` `:16-43`, `ExecutorOutput` `:112-121`)
- `src/scripts-runtime/executors/native.ts` (result read `:549`)
- `src/scripts-runtime/executors/quickjs.ts`
- `src/scripts-runtime/loader.ts` (`:102-128`, `:202-210`)

**Changes**:
- Add `durable?: DurableInvocation` to the payload and `durable?: { state, destroyed, idleTtlSec }` to the output.
- Each executor unpacks the envelope into `output.durable`, leaving `output.result` as the method's result. That happens before `loader.ts` scrubs `result`, so state is never scrubbed.
- `runScript` takes `durable` on its input and puts it on the payload.

#### 5. ctx.caller
**Files**:
- `src/scripts-runtime/ctx.ts` (`buildCtx` `:37-67`)
- `src/scripts-runtime/executors/quickjs-prelude.ts` (`:455`)
- `src/scripts-runtime/sdk-allowlist.ts` (`RESERVED_CTX_KEYS` `:291-302`)

**Changes**: Add `caller` (from `payload.durable?.caller` or `payload.caller`, frozen JSON) to both ctx builds. Add `caller` to `RESERVED_CTX_KEYS`.

#### 6. Typecheck
**File**: `src/be/scripts/typecheck.ts` (`SCRIPT_SDK_TYPES` `:32`, `ScriptContext` `:899-922`, `ScriptMain` `:936`, check file `:1597-1607`)
**Changes**:
- Declare `export abstract class DurableObject<S> { readonly id: string; state: S; abstract initialState(): S | Promise<S>; migrate?(state: unknown, fromVersion: number): S | Promise<S>; destroy(): void; static idleTtlSec?: number }`.
- Add `caller: ScriptCaller` to `ScriptContext`.
- Change the check to `const _scriptMain: ScriptMain | (abstract new (id: string) => DurableObject<any>) = run;`.
- Add `object?: { id: string; method: string }` to `script_run` at `:480`.
- Run `bun run build:script-types`.

#### 7. Signature extraction and upsert refusal
**Files**:
- `src/scripts-runtime/extract-signature.ts` (`:50-81`)
- `src/http/scripts.ts` (upsert handler `:659-752`)
- `src/tools/script-upsert.ts` (`:28-30` description)

**Changes**:
- For `export default class X extends DurableObject`, return `{ kind: "durable", methods: { <name>: { argsType, resultType, description } }, argsType: "unknown", resultType: "unknown", description }`. The `methods` are own non-static, non-reserved methods.
- Upsert returns 400 with "DurableObject scripts must be global scope" when the kind is `durable` and the scope is not `global`. Place it next to `refuseSourceWithSecrets` (`:689-693`).
- The inline run path refuses a `durable` source with a 400 and does not auto-save it as scratch (`:880-894`).
- Update the tool description.

### Success Criteria:

#### Automated Verification:
- [x] Types pass: `bun run tsc:check && bun run tsc:check:tsc`
- [x] Generated SDK types are fresh: `bun run build:script-types && git diff --exit-code src/scripts-runtime/types/ || (git add src/scripts-runtime/types/ && echo regenerated)`
- [x] Lint passes: `bun run lint && bun run lint:slop`
- [x] Boundaries hold: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`
- [x] Existing script scenarios still pass: `bun run e2e --only script-inline-run,script-saved-lifecycle,script-sdk-calls,script-limits`

#### Automated QA:
- [x] Add the upsert half of the new scenario, `scripts/e2e/scenarios/script-durable-objects.ts` (order 490, `flows` entry `"durable-objects"` in `scripts/e2e/coverage-manifest.json`). Run it with `bun run e2e --only script-durable-objects`. It checks:
  - [x] a global upsert of the `Counter` class succeeds;
  - [x] `script-query-types` with `name` shows `kind: "durable"` and method `add` only;
  - [x] an agent-scope upsert returns the "must be global scope" error;
  - [x] an inline `script_run` of the class source is refused;
  - [x] a function script upsert is unchanged.

#### Manual Verification:
- [ ] None.

**Implementation Note**: After this phase, pause for confirmation. Commit as `[phase 1] DurableObject runtime kind`.

---

## Phase 2: State engine, lease and migration

### Overview

Deliverable: the API-side module `src/be/scripts/durable.ts`, the `durable` KV family guard with scrubbed reads, and migration `<NNN>_durable_objects.sql`. The engine is complete, but nothing routes to it until Phase 3.

### Changes Required:

#### 1. Migration
**File**: `src/be/migrations/<NNN>_durable_objects.sql` (NNN from Phase 0)
**Changes**:
- `ALTER TABLE session_tokens ADD COLUMN objectChain TEXT;`
- `ALTER TABLE session_tokens ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;`
- `ALTER TABLE script_runs ADD COLUMN objectScriptId TEXT;`
- `ALTER TABLE script_runs ADD COLUMN objectId TEXT;`
- `ALTER TABLE script_runs ADD COLUMN objectMethod TEXT;`
- A partial index on `script_runs(objectScriptId, objectId) WHERE objectId IS NOT NULL`.

#### 2. Engine
**File**: `src/be/scripts/durable.ts` (new)
**Changes**: Export `callDurableObject({ script, objectId, method, args, agentId, caller, provenance, executor, fsMode, nested })`. It does the following, in order:
1. Check `method` against `JSON.parse(script.signatureJson).methods` (error "not callable").
2. Re-entry: if `${script.id}:${objectId}` is in `provenance.objectChain`, fail with "already in this call chain".
3. Take the lease. Loop on `claimKv({ namespace: "durable:<scriptId>", key: "lease/<id>", value: { token }, valueType: "json", expiresAt: now + wallClock + 10_000 })` with jittered backoff (50-400 ms). The cap is 30 s for a top-level call and 5 s when `nested`. After the cap, fail with "object busy".
4. Load: `getKv(ns, "state/<id>")` gives `{ codeVersion, stateVersion, state }` or nothing.
5. Run `runScriptWithRunCredential` with `durable: { id, method, state, codeVersion: script.version, storedCodeVersion, caller }`. Pass provenance with `objectChain + [scriptId:id]` and `depth`.
6. On failure, timeout or a missing `output.durable`: in a transaction, delete `lease/<id>` if the token still matches. Return the error.
7. Size check: `JSON.stringify(state)` must be at most 2 MiB (`MAX_KV_BODY_BYTES`). Otherwise release the lease and fail with "state too large".
8. Commit in `getDbClient().transaction`:
   - Lease token mismatch: fail with "lease lost".
   - `destroyed`: `deleteKv(state)`.
   - Changed state: `upsertKv(state, { codeVersion, stateVersion: +1, state }, expiresAt: idleTtlSec ? now + idleTtlSec*1000 : null)`.
   - Unchanged state, with `idleTtlSec` set: refresh `expiresAt` only.
   - Finally `deleteKv(lease)`.
9. Return `{ output, object: { id, stateVersion, destroyed } }`.
- **Constraints:**
  - All calls go through `getDbClient()` with `await` (async seam). No `getDb()`.
  - The engine does no publishing in PR 1. The realtime feed is PR 4.

#### 3. KV family guard and scrubbed reads
**Files**:
- `src/kv-reserved-namespaces.ts` (`:7-29`)
- `src/tools/kv/kv-get.ts` (`:183`), `src/tools/kv/kv-list.ts` (`:67`)
- `src/http/kv.ts` (`sendGet` `:686-705`, `sendList` `:786-796`)

**Changes**:
- Add `["durable", "namespace holds durable object state; it is written only by object calls"]`. That blocks writes on both write paths.
- Reads stay open. For namespaces whose family is `durable`, pass values through `scrubObject` (`src/utils/secret-scrubber.ts:1578`) before egress, in all four read sites. Put the logic in one helper, `scrubReservedRead(namespace, value)` in `src/kv-reserved-namespaces.ts`.

#### 4. Provenance plumbing
**Files**:
- `src/be/users.ts` (`mintScriptRunToken` `:746-771`, resolution `:1050-1119`)
- `src/utils/request-auth-context.ts` (`:30`, `:108-121`)
- `src/be/scripts/run-credential.ts` (`ScriptRunProvenance` `:44`)

**Changes**:
- Extend the provenance type to `{ sourceStepId?, sourceScriptRunId?, objectChain?: string[], depth?: number }`.
- Write `objectChain` (JSON) and `depth` in the existing UPDATE. Select and return them in token resolution, and expose them through `getCurrentRunProvenance()`.
- Merge the two identical provenance declarations into one exported type.

### Success Criteria:

#### Automated Verification:
- [x] Migration ordinal is valid: `bash scripts/check-migration-conflicts.sh`
- [x] Fresh DB boots: `rm -f /tmp/do-pr1-fresh.sqlite && DATABASE_PATH=/tmp/do-pr1-fresh.sqlite PORT=3399 DESPLEGA_TELEMETRY_ENV=test timeout 25 bun run start:http 2>&1 | grep -iE "migrat|listening" | tail -5`
- [x] Existing DB upgrades. **Before** adding the migration file, create a pre-migration DB: `rm -f /tmp/do-pr1-existing.sqlite && DATABASE_PATH=/tmp/do-pr1-existing.sqlite PORT=3398 DESPLEGA_TELEMETRY_ENV=test timeout 25 bun run start:http >/dev/null 2>&1; true`. After adding it, boot the same file again: `DATABASE_PATH=/tmp/do-pr1-existing.sqlite PORT=3398 DESPLEGA_TELEMETRY_ENV=test timeout 25 bun run start:http 2>&1 | grep -iE "migrat|listening" | tail -5`. Then check `sqlite3 /tmp/do-pr1-existing.sqlite "PRAGMA table_info(session_tokens)" | grep objectChain`.
- [x] Columns exist: `sqlite3 /tmp/do-pr1-fresh.sqlite "PRAGMA table_info(session_tokens)" | grep -E "objectChain|depth" && sqlite3 /tmp/do-pr1-fresh.sqlite "PRAGMA table_info(script_runs)" | grep -E "objectId|objectMethod|objectScriptId"`
- [x] Types and lint: `bun run tsc:check:tsc && bun run lint`
- [x] Async-seam checks: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bash scripts/check-async-db-seam.sh`
- [x] KV and script scenarios still pass: `bun run e2e --only script-kv,script-saved-lifecycle,script-inline-run`

#### Automated QA:
- [x] Extend `script-kv` or `script-durable-objects` (whichever has no dependency on Phase 3): `kv_set` / `kv_delete` / `kv_incr` on namespace `durable:<nonce>` are refused on both MCP and HTTP, and `kv_get` on it is allowed. Run: `bun run e2e --only script-durable-objects,script-kv`.

#### Manual Verification:
- [ ] None.

**Implementation Note**: After this phase, pause for confirmation. Commit as `[phase 2] durable object state engine, lease, migration`. Delete `/tmp/do-pr1-*.sqlite*`.

---

## Phase 3: `script_run` with `object` (tool, HTTP, SDK)

### Overview

Deliverable: `script_run({ name, object: { id, method }, args })` works from agents (MCP and HTTP) and from scripts (`ctx.swarm.script_run`). It covers re-entry and the depth limit, run rows with object columns, and an `object` field in the response. The full e2e scenario is green on both executors.

### Changes Required:

#### 1. Run route
**File**: `src/http/scripts.ts` (`runBodySchema` `:77-90`, handler `:754-940`, `scriptRunResponseSchema` `:167-204`)
**Changes**:
- Add `object: z.object({ id: z.string().min(1).max(256), method: z.string().min(1).max(128) }).optional()`, with a refine that `object` requires `name`.
- For a named run, resolve the script. Then:
  - If `signatureJson.kind === "durable"`, require `object`, then call `callDurableObject` with `nested = provenance !== null`. The script must be global, which upsert already guarantees, so treat any non-global kind as a 400.
  - If the script is a function and `object` is present, return 400 "not a DurableObject".
- Depth: for every run, read `provenance.depth ?? 0`. If it is above 16, return 400 "call depth exceeds 16". Otherwise pass `depth + 1` to the minted token.
- `recordInlineScriptRun` gains `objectScriptId`, `objectId` and `objectMethod` (`db.ts:14435`).
- The response gains optional `object: { id, stateVersion, destroyed }`.
- **Status codes:**
  - 409 for "object busy" and for re-entry.
  - 400 for "not callable", "too large" and the kind mismatch.
  - 409 for "lease lost".

#### 2. Tool and nudges
**Files**:
- `src/tools/script-run.ts` (`:55-93`, `SCRIPT_RUN_DESCRIPTION` `:14`, `renderRunOutput` `:16-46`)
- `src/tools/utils.ts` (`scriptRunNudge` `:285-290`)

**Changes**:
- Add the `object` input field and describe it in one sentence. Render `object.stateVersion` when it is present.
- Chain a busy nudge inside `scriptRunNudge`: "object busy: retry the call later, do not loop."

#### 3. Generated artifacts
**Files**: `openapi.json`, `docs-site/content/docs/api-reference/**`, `src/scripts-runtime/types/*.d.ts`
**Changes**: Run `bun run docs:openapi` and `bun run build:script-types`. Commit the outputs.

### Success Criteria:

#### Automated Verification:
- [x] Types, lint, seam: `bun run tsc:check:tsc && bun run lint && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [x] Generators clean: `bun run docs:openapi && bun run build:script-types && git status --porcelain openapi.json docs-site src/scripts-runtime/types`. Commit any diff.
- [x] Gates: `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun scripts/check-sdk-tool-registration.ts`
- [x] Full script band: `bun run e2e --only script-durable-objects,script-inline-run,script-saved-lifecycle,script-sdk-calls,script-kv,script-limits,script-apis`

#### Automated QA:
- [x] Complete `script-durable-objects` and run it with `bun run e2e --only script-durable-objects`. Each case runs once with `executor: "native"` and once with `executor: "quickjs"`:
  - [x] Two `add` calls on id `a` return 2, then 4. Id `b` starts at 0.
  - [x] Five concurrent `add({ by: 1 })` calls on a fresh id finish with a final state of 5, and every call returns a distinct value.
  - [x] A method that throws leaves the state unchanged.
  - [x] `method: "initialState"` and `method: "_secret"` are refused, and no lease row exists afterwards (`ctx.db.get` on `kv_entries`).
  - [x] `destroy()` and then a call returns the initial state.
  - [x] A method that calls its own object through `ctx.swarm.script_run` gets the re-entry error.
  - [x] A plain script that calls itself recursively fails with the depth error at 17. Risk: 17 live nested runs may hit the script concurrency cap first (skill `### Concurrency limit`). If they do, check the cap value in code. Then either raise it for the e2e SUT via `ctx.restartSut({ env })`, or seed the depth through a chain of distinct scripts. Do not add a new env var for the depth limit.
  - [x] `ctx.restartSut()` keeps the state.
  - [x] `static idleTtlSec = 1`: after about 2 s the object is fresh.
  - [x] Upserting v2 with `migrate` changes the shape on the next call.
  - [x] `kv_get` on `state/a` returns the snapshot, and a secret-shaped string inside the state comes back scrubbed.
  - [x] Run rows carry `objectId` and `objectMethod` (`ctx.db.get` on `script_runs`).

#### Manual Verification:
- [ ] None. The Manual E2E section below covers a real backend.

**Implementation Note**: After this phase, pause for confirmation. Commit as `[phase 3] script_run object target`.

---

## Phase 4: Docs, skill and final gate

### Overview

Deliverable: the `swarm-scripts` skill section "Durable objects", the regenerated `SKILL.md`, the MCP and docs mentions, and a full green gate run.

### Changes Required:

#### 1. Skill
**File**: `templates/skills/swarm-scripts/content.md` (after `### Durable workflow scripts` `:117-122`, and `ctx.caller` in `### What ctx holds` `:89`)
**Changes**: Add a "Durable objects" section. It covers:
- the class contract;
- how to call an object;
- state rules: JSON only, 2 MiB, saved only on success, mutations after return are lost, destroy resurrection, at-least-once is not relevant yet;
- the busy and re-entry errors;
- a "differences from Cloudflare" table (no `this.ctx.storage`, no `fetch()`, no `env`, methods take `(args, ctx)`).

Then run `bun run build:skill-md`.

#### 2. Docs
**Files**: `MCP.md` (the `script-run` entry), the docs-site scripts page (find it with `grep -rl "script_run\|script-run" docs-site/content/docs`)
**Changes**: One short subsection with the `object` field and one example. If the page frontmatter changed: `bun run build:docs-index`.

### Success Criteria:

#### Automated Verification:
- [x] Skill drift: `bun run build:skill-md && bun run check:skill-md && bun run check:skill-sources`
- [x] Full local gate: `bun run check:local`
- [x] CI mirror: `bun run lint && bun run lint:slop && bun run tsc:check:tsc && bun run test:root -- --parallel=4 && bun run e2e`

#### Automated QA:
- [x] Rendered skill check: `grep -n "Durable objects" templates/skills/swarm-scripts/SKILL.md`, and the example in the skill passes `script_upsert` typecheck. Paste it into a `script_upsert` call in the e2e scenario, or into a quick local run.

#### Manual Verification:
- [ ] Taras reads the skill section for tone and accuracy.

**Implementation Note**: After this phase, pause for confirmation. Commit as `[phase 4] durable objects docs and skill`. Clean `/tmp/do-pr1-*`.

---

## Manual E2E

Run against a local API server with a fresh DB. Use a UUID agent id.

```bash
export DATABASE_PATH=/tmp/do-pr1-manual.sqlite; rm -f $DATABASE_PATH
DESPLEGA_TELEMETRY_ENV=test PORT=3013 bun run start:http &   # API on :3013
export AGENT_ID=$(uuidgen) KEY=${AGENT_SWARM_API_KEY:-123123} BASE=http://localhost:3013
curl -s -X POST $BASE/api/agents -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"id\":\"$AGENT_ID\",\"name\":\"do-manual\",\"isLead\":true}"   # POST /api/agents (src/http/agents.ts:154)

# 1. Upsert the object script (global)
curl -s -X POST $BASE/api/scripts/upsert -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" -d '{
  "name":"counter","scope":"global","intent":"manual e2e",
  "source":"import { DurableObject } from \"swarm-sdk\";\nexport default class Counter extends DurableObject<{n:number}> {\n  initialState(){ return { n: 0 }; }\n  async add(args:{by:number}){ this.state.n += args.by; return this.state.n; }\n}"}' | jq .

# 2. Call it twice, then on another id
for i in 1 2; do curl -s -X POST $BASE/api/scripts/run -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d '{"name":"counter","intent":"manual","object":{"id":"a","method":"add"},"args":{"by":2}}' | jq '.result, .object'; done
curl -s -X POST $BASE/api/scripts/run -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d '{"name":"counter","intent":"manual","object":{"id":"b","method":"add"},"args":{"by":1}}' | jq '.result'   # expect 2, 4, then 1

# 3. Concurrency: 5 parallel calls on id c, expect final 5
for i in 1 2 3 4 5; do curl -s -X POST $BASE/api/scripts/run -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d '{"name":"counter","intent":"manual","object":{"id":"c","method":"add"},"args":{"by":1}}' | jq -c '.result' & done; wait

# 4. Inspect and try to write
SID=$(sqlite3 $DATABASE_PATH "select id from scripts where name='counter'")
curl -s "$BASE/api/kv/_/durable:$SID/state%2Fc" -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AGENT_ID" | jq .   # explicit-namespace route, key is URL-decoded (src/http/kv.ts:278)
curl -s -X PUT "$BASE/api/kv/_/durable:$SID/state%2Fc" -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" -d '{"value":{"n":99}}' | jq .   # expect 403 refusal

# 5. Refused method and agent-scope upsert
curl -s -X POST $BASE/api/scripts/run -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d '{"name":"counter","intent":"manual","object":{"id":"a","method":"initialState"}}' | jq .   # expect "not callable"

# 6. Same call on QuickJS (the deployment must allow the quickjs executor)
curl -s -X POST $BASE/api/scripts/run -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $AGENT_ID" -H "Content-Type: application/json" \
  -d '{"name":"counter","intent":"manual","executor":"quickjs","object":{"id":"q","method":"add"},"args":{"by":3}}' | jq '.result, .object'   # expect 3

# Cleanup
kill %1; rm -f /tmp/do-pr1-manual.sqlite*
```

Optionally, after merge to `main` (auto-deploys to prod): repeat steps 1-2 through `mcp__agent-swarm-user__script-run` against the prod swarm with a throwaway script name, then delete the script.

---

## Appendix

- **Follow-up plans** (to be created after PR 1 merges, each with `/desplega:create-plan`):
  - **PR 2, alarms and long work:**
    - Schedules (`scheduled_tasks` object columns, migration) and the `swarm-script` node `object` field, with targets stored as `scriptId`.
    - `script_launchRun` `onComplete`, with `script_runs.onCompleteJson` + `callbackFiredAt`, at-least-once dispatch via `afterCommit`, a busy retry, and a startup reconcile.
    - The "stored codeVersion newer than running" check for `pinHash` nodes.
    - `ctx.caller` kinds `schedule`, `workflow` and `callback`.
  - **PR 3, typing and Apps:** a 4th type contributor (`DurableRegistry`), `ctx.durable.<camelName>(id).<method>()` in both preludes and in the native ctx, the camelCase collision refusal at upsert, App action `object` (`apps/definition.ts:350`), and `ctx.caller.kind = "app"`.
  - **PR 4, public surfaces:**
    - `static exposed`.
    - Page SDK `swarmSdk.durable(...)` and `.subscribe()`.
    - `script_apis` `objectMethod` + `idPattern` (migration).
    - The realtime namespace `durable:<scriptId>` (subscribe-only) with hashed channel names, published after commit.
    - Rate limits for `page` / `http` callers.
  - **Later:** extensions (`ctx.durable` in hook ctx, bundled object scripts, a short hook lease wait).
- **Derail notes:**
  - Run rows: App actions, UI-spec actions, app sync, heartbeat, follow-up gate and `swarm-script` steps write no `script_runs` row today (`runSavedScriptAsAgent`). PR 2 and PR 3 must add rows for object calls on those paths.
  - `kv_entries.created_by` / `updated_by` are never populated (no writer sets them).
  - Paused script runs never resume (no code moves `paused` to `running`).
  - Signature callers outside HTTP upsert (seed scripts, dir import, extension assets) will extract `kind: "durable"`, but they skip the global-scope refusal. Extension assets are global, so this is fine for now.
  - The QuickJS bundle cache key is `Bun.hash(source)`, so a `SWARM_SDK_MODULE` change does not invalidate cached bundles inside a running process. A restart is needed after deploy, and that happens anyway.
- **References**:
  - Research: `thoughts/taras/research/2026-11-17-durable-script-objects.md`
  - Spikes: `thoughts/taras/research/2026-11-17-durable-objects-pr1-spikes.md`
  - Brainstorm: `thoughts/taras/brainstorms/2026-11-17-durable-script-objects.md`
