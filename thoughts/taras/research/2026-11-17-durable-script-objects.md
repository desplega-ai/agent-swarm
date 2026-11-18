---
date: 2026-11-17T18:30:00+01:00
researcher: Claude
git_commit: f59cce3d8626b83991f1068747da5db97ca6161e
branch: t3/brainstorm-durable-script-worker
repository: desplega-ai/agent-swarm
topic: "Code paths a DurableObject-style script kind would touch"
tags: [research, codebase, scripts-runtime, kv, script-workflows, schedules, apps, script-apis]
status: complete
autonomy: critical
last_updated: 2026-11-17
last_updated_by: Claude
revision: 2 (integration surfaces + open questions resolved)
---

# Research: Code paths a DurableObject-style script kind would touch

**Date**: 2026-11-17 18:30 BCN
**Researcher**: Claude
**Git Commit**: f59cce3d86
**Branch**: t3/brainstorm-durable-script-worker

## Research Question

Document, as-is, the code that a DurableObject-style script kind would touch. Input brainstorm: [2026-11-17-durable-script-objects.md](../brainstorms/2026-11-17-durable-script-objects.md). Areas:
1. The script eval epilogues (native `eval-harness.ts`, QuickJS `quickjs-prelude.ts`).
2. `script_upsert`: typecheck and signature extraction.
3. KV internal writers (`upsertKv` / `claimKv`) and reserved families.
4. Durable script run finish paths, plus `afterCommit` and the event bus.
5. The `script_runs` parent chain and the per-run credential.
6. The five call sites: `script_run`, schedules, the `swarm-script` node, App script actions, `script_apis` HTTP endpoints.

## Summary

**Both executors support only a default function export, and both return results as plain JSON.**
- The native harness imports the module, checks `typeof mod.default === "function"`, calls `mod.default(validatedArgs, ctx)`, and writes `JSON.stringify(result ?? null)` to a result file (`eval-harness.ts:131-169`). It then waits up to 2 s for un-awaited work.
- QuickJS bundles the source as an IIFE that puts the whole module namespace on `globalThis.__swarm_module` (`quickjs-bundle.ts:104`). The epilogue makes the same check and plain call, then posts JSON back (`quickjs-prelude.ts:477-626`). Pending work is dropped at dispose.
- `runScript` returns `ExecutorOutput` (`result`, `stdout`, `stderr`, `truncated`, `durationMs`, `exitCode`, `error?`, `runtimeError?`). It retries `capacity_exceeded` at 200 ms and 750 ms (`loader.ts:38,130-211`).

**Upsert pins the function shape in two places.**
- Typecheck appends `const _scriptMain: ScriptMain = run` against `ScriptMain = (args, ctx) => unknown` (`typecheck.ts:936,1604-1609`).
- `extract-signature.ts` reads only default function or arrow exports into `scripts.signatureJson`.
- `argsJsonSchema` comes from a sandboxed extraction of an optional zod `argsSchema` export.
- Saved scripts resolve by name (agent scope first, then global) or by id, and a workflow node can pin a version through `pinHash`.

**KV has a lease primitive, and durable runs have no finish event.**
- `claimKv` inserts if the key is absent, or overwrites if the row is expired, and returns `changes > 0` (`db.ts:14053-14075`). Five subsystems already use it as a TTL lease (agentmail, kapso, slack session mirror, slack external channel, comb).
- `RESERVED_FAMILIES` in `src/kv-reserved-namespaces.ts` drives both write-guard copies (tool `kvWriteAuthError`, HTTP `authorizeWrite`).
- Durable runs reach a terminal status through three guarded update functions, called from the status route, the supervisor `exited` handler, spawn-error paths, cancel, and `abortScriptRunLimit`.
- No `script_run.*` event exists on `workflowEventBus`. `afterCommit` hooks queue inside a transaction, drop on rollback, and run after COMMIT. The bus is in-process and synchronous.

**Points that bear on the brainstorm's assumptions** (facts, see Detailed Findings):
- **Inline run rows are written after the run.** `recordInlineScriptRun` inserts the `script_runs` row already terminal (`db.ts:14432-14490`). This covers `/api/scripts/run`, schedules, `x.ts` endpoints and user-code mode. So while a nested `ctx.swarm.script_run` executes, its ancestors have no `running` row to walk. `parentScriptRunId` is set from the caller's token provenance.
- **Some paths write no row at all.** `swarm-script` workflow steps and `runSavedScriptAsAgent` (App actions) call `runScriptWithRunCredential` without recording a `script_runs` row. The workflow step passes only `sourceStepId`.
- **No depth limit for nested scripts.** The nearest precedent is `MAX_SUB_WORKFLOW_DEPTH = 16`, checked through lineage plus cycle detection (`sub-workflow.ts:33-34,105-115`).
- **`claimKv` and `upsertKv` are single statements with no transaction wrapper.** Only `incrKv` uses `getDbClient().transaction`.
- **`workflowEventBus` is an in-process `EventEmitter`** (`src/realtime/bus.ts:13-15`). A finish event emitted on one API process reaches listeners only in that process.
- **The five call sites address scripts and enforce access differently.** Name in global scope (schedules), name with agent-then-global (`script_run`, workflow node), and uuid (App action, endpoint row). Access goes through `requireAgent` (`/api/scripts/run`), `app.use` (Apps), and `authMode none|bearer` (`x.ts`). Only the user-MCP `script-run` declares `rbac: permission("script.run")`.

**Integration surfaces (round 2, after Taras's review).**
- **Extensions:**
  - Hooks run in the API process as a loaded module. The default export registers handlers, and each event calls a handler with a fresh `ctx`.
  - State lives in `ctx.state` (KV keys prefixed `ext:<name>:`) or in module scope. Nothing serializes calls per entity.
  - Bundled `assets.scripts` are ordinary global scripts owned by the `ext:<name>` agent. `ctx.swarm.script_run` is reachable.
- **Pages:**
  - HTML pages run in a sandboxed iframe, with `window.swarmSdk` injected as plain JS.
  - State is KV `task:page:<id>`, routed by the `X-Page-Id` header.
  - The SDK has no `scripts`, `apps` or `x` domain, and pages have no typed client.
  - Realtime comes through `swarmSdk.room()` / `channel()` (Yjs over WebSocket).
- **Apps:**
  - `getScriptAppTypes` renders every app as `export namespace App_<Name>` into the script ambient types.
  - Scripts reach apps through flat SDK methods (`app_query`, `app_row_*`). There is no `ctx.apps` namespace and no action-run SDK method.
  - No generator turns one saved script's `signatureJson` into typed args and result for another script. `script_run` returns `unknown`.
  - **`SDK_NAMESPACES` already holds an `objects` key** (with `sheets` and `boards`), so `ctx.objects` is taken.
- **Realtime and streaming:**
  - The API is a `node:http` server with two WebSocket upgrade paths (`/@swarm/realtime`, `/api/realtime`) plus the controller socket.
  - SSE exists only inside the MCP SDK transport. Script runs are request/response with one final result.
  - The single-replica assumption is written only in `runbooks/realtime-rooms.md:89`.

## Detailed Findings

Each subsection below is a sub-agent report with file:line refs and verbatim quotes. Headings are demoted one level. Each report ends with its own "Gaps" list, which is collected again under Open Questions.

### 1. Script eval epilogues and the host-guest result contract

#### Native harness flow (`src/scripts-runtime/eval-harness.ts`)

Top-level `try` runs the whole flow. It reads the config from stdin, parses it, and builds ctx. It then imports the module and calls the default export.

```ts
const stdin = await Bun.stdin.text();
...
const payload = JSON.parse(stdin) as SwarmConfigPayload;
```
(`eval-harness.ts:100-106`)

- An empty stdin emits an error and exits 2 (`:101-104`).
- It patches fetch for egress secrets (`:107`).
- Args come from the file at `SWARM_SCRIPT_ARGS_FILE`. A string value is JSON-parsed a second time (`:109-111`).
- `buildCtx({swarmConfig, apiConnections, mcpConnections, agentFs})` runs at `:112-117`. No `signal` or `namespaces` is passed.
- The source file is copied to `${SWARM_SCRIPT_TMPDIR}/user-module/user-script.ts` when the paths differ (`:119-123`).
- `startedFile` is written ("1") right before the import. The comment at `:75-80` says it must stay the last framework statement before the user-code boundary (`:125`).
- The module loads via `import(Bun.pathToFileURL(...).href)` (`:131`).
- A non-function `mod.default` throws "Swarm script must export a default function..." (`:132-136`). No other export shape is checked.
- `argsSchema` is used only when it is an object with a `parse` property. The parse is skipped when `SWARM_SCRIPT_HOST_VALIDATED_ARGS=1` and `isHostValidationEquivalent` returns true (`:138-146`).
- ZodError `issues` are rewritten as `argsSchema validation failed:\n  path: message` (`:151-162`).
- The call and the result write:

```ts
const result = await mod.default(validatedArgs, ctx);
await Bun.write(requiredEnv("SWARM_SCRIPT_RESULT_FILE"), JSON.stringify(result ?? null));
```
(`:168-169`)

- After the write, an unref'd `setTimeout` of `UNAWAITED_WORK_DRAIN_MS` (2000, `executors/types.ts:131`) logs a stderr notice and calls `process.exit(0)` (`eval-harness.ts:177-182`). With nothing pending, the process exits on its own.
- Errors go through `emitError` (`:83-97`) and then `process.exit(1)`. `emitError` builds a `StructuredError` (`:15-23`, `:25-65`). It keeps only stack frames inside `user-script.ts`, plus an optional `ctxSignatureHint` (`:54`). It prints the filtered stack to stderr and writes the JSON to `SWARM_SCRIPT_ERROR_FILE`.

#### Native host side (`executors/native.ts`, `loader.ts`)

- The host sets these env vars on the child: `SWARM_SCRIPT_TMPDIR`, `_ARGS_FILE`, `_SOURCE_FILE`, `_RESULT_FILE`, `_ERROR_FILE`, `_STARTED_FILE`, and optionally `_HOST_VALIDATED_ARGS` (`native.ts:280-286`).
- Run-dir files are `args.json`/source/`result.json`/`error.json` under `${tmpdir}` (`native.ts:265-266`).
- The host writes args and source (`:509-511`). It writes `JSON.stringify(input.configPayload)` to the child's stdin and closes it (`:535-536`).
- It awaits capped stdout, capped stderr and `child.exited` (`:538-542`).
- It then reads the result and error files:

```ts
const result = exitCode === 0 ? await readResultFile(resultFile, runDirCheck) : undefined;
const runtimeError = exitCode === 0 ? undefined : await readRuntimeError(errorFile, runDirCheck);
```
(`native.ts:549-551`)

- `readRunDirFile` (`:97-126`) opens the file with `O_NOFOLLOW|O_NONBLOCK`. It requires a regular file, the expected owner uid and a size under `maxFileBytes`. Anything else reads as absent.
- `readResultFile` does `JSON.parse` of the text, and an empty text gives `undefined` (`:138-142`). `readRuntimeError` swallows parse errors (`:144-155`).
- `classifyExit(exitCode, timedOut, killed, userCodeStarted)` (`:62-76`) maps exit codes to error kinds:
  - 134 gives `capacity_exceeded` if user code has not started, else `eval_error`.
  - `timedOut` gives `timeout`.
  - `killed`, 137 or 9 give `killed`.
  - Any other non-zero code gives `eval_error`.
- Exceptions in the host path return `executor_error`, or `timeout`/`killed` when those flags are set (`:567-576`).
- `runScript` (`loader.ts:130-211`) short-circuits with `executor_error` for `workspace-rw` and for a disallowed executor. It returns `import_violation` when `validateScriptImports` fails.
- Otherwise it builds the config payload (`:102-128`), calls `resolveScriptExecutor(input.executor).run(...)` (`:195`), and retries `capacity_exceeded` at delays `[200, 750]` ms (`:38`, `:196-200`).
- Finally it scrubs `result`, `stdout`, `stderr` and `runtimeError` (`:202-210`).

#### Return shape (`executors/types.ts:112-121`, `loader.ts:83-87`)

```ts
export type ExecutorOutput = {
  result: unknown | undefined;
  stdout: string; stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number; exitCode: number;
  error?: ScriptExecutorError; runtimeError?: ScriptRuntimeError;
};
```

- `RunScriptOutput` is `Omit<ExecutorOutput, "result"|"stdout"|"stderr"> & {result, stdout, stderr}`, so it has the same fields.
- `ScriptExecutorError` values: `timeout`, `oom`, `killed`, `import_violation`, `eval_error`, `executor_error`, `capacity_exceeded` (`types.ts:75-94`).
- `ScriptRuntimeError` is `{name, message, stack, userFrames[], userScriptLine?, userScriptColumn?}` (`:103-110`).
- There is no separate "logs" field. Logs are `stdout`/`stderr` text with truncation flags.

#### QuickJS bundling (`executors/quickjs-bundle.ts`)

`bundleForQuickJS(source)` calls `Bun.build` with in-memory files. It uses format `iife`, target `browser`, an external sourcemap, and minify with identifiers kept.

```ts
[ENTRY_PATH]: `import * as m from "./${USER_SCRIPT_FILE}";\nglobalThis.__swarm_module = m;\n`,
```
(`:104`)

- The whole module namespace becomes `__swarm_module`, so `argsSchema` and any other export are present on it.
- A plugin maps `stdlib` and `swarm-sdk` to virtual modules that read `globalThis.__swarm_stdlib` and `globalThis.__swarm_ctx.swarm` (`:30-33`, `:117-124`). It resolves `zod` and `zod/mini` through `resolveZodEntry` (`:125-133`).
- The result is an LRU cache (limit 128) keyed by `Bun.hash(source)` (`:76-86`, `:89-95`).
- A build failure returns `{ok:false, diagnostic}` (`:138-152`).

#### QuickJS job evaluation (`executors/quickjs-runner.ts`)

- A build failure returns `exitCode 1`, `error "eval_error"` and a `runtimeError` named `BuildError` (`:524-538`).
- `buildCtx` runs on the host with `signal: host.signal` and `namespaces` (`:542-549`). The guest then gets a proxy `ctx` shaped by `__swarm_shape`. `shape` lists api/mcp/fs keys, `namespaces` and `hasRuntimeInstanceId` (`:553-559`).
- The prelude defines `__swarm_ctx` and `__swarm_stdlib` (`quickjs-prelude.ts:468-469`).
- Args are JSON-parsed if they are a string (`:561`).
- Evaluation order, with the init script at `:675`:

```ts
evaluate(init, "swarm-init.js") && evaluate(SANDBOX_WEB_SHIMS, ...) && ... 
evaluate(SANDBOX_PRELUDE, ...) && evaluate(bundle.code, BUNDLE_FILE) && evaluate(SANDBOX_EPILOGUE, ...)
```
(`:675-682`; the init sets `__swarm_shape`, `__swarm_args`, `__swarm_host_validated_args`)

- A single `done` promise resolves with an `Outcome` (`:84`, `:572-575`). It races a wall-clock timer that resolves `InternalError "interrupted"` (`:687-697`).
- `classify` (`:127-131`) maps `InternalError "interrupted"` to `timeout`, `"out of memory"` to `oom`, and anything else to `eval_error`.
- Success returns `output({result, exitCode: 0})` (`:699`). A timeout returns exit code 124 (`:81`, `:701-703`).
- Other errors return `exitCode 1` plus `runtimeError = structuredError(outcome.error, bundle.map)` and a stderr line (`:705-707`).
- `finally` sets `alive=false`, disposes pending promises, the context and the runtime (`:708-718`). Anything still pending is dropped, so there is no drain window.
- `QuickJSJobResult` is `{output: ExecutorOutput, leakedHostCalls}` (`:72-76`).

#### QuickJS epilogue and JSON contract (`quickjs-prelude.ts:477-626`)

The epilogue first redefines the structural-schema helpers `isStructuralSchemaNode` and `isHostValidationEquivalent` (`:478-573`). These mirror `host-validated-args`.

- `mod = globalThis.__swarm_module` must have a function `default`, otherwise it throws the same error as native (`:574-579`).
- The `argsSchema` handling is the same as native (`:580-599`).
- The call is `return await mod.default(args, globalThis.__swarm_ctx)` (`:600`).

```js
json = JSON.stringify({ ok: true, result: value === undefined ? null : value });
...
__host_done(json);
```
(`:605-612`)

- A non-serializable result becomes `{ok:false, error:{name:"TypeError", message:"Script result is not JSON-serializable: ..."}}` (`:607-610`).
- A rejection becomes `{ok:false, error:{name, message, stack}}` (`:614-624`).
- The host's `__host_done` does `finish(JSON.parse(...) as Outcome)` (`quickjs-runner.ts:656-658`). `Outcome` is `{ok:true,result}|{ok:false,error:ErrorPayload}` (`:83-84`).
- The native result goes through a file and `JSON.stringify(result ?? null)`. The QuickJS result goes through the `__host_done` bridge with the same null coalescing.

#### ctx construction (`src/scripts-runtime/ctx.ts`)

`buildCtx` takes `{swarmConfig, apiConnections?, mcpConnections?, agentFs?, signal?, namespaces?}` (`:37-53`). It returns:

```ts
...createNamespaceClients(swarmConfig, { signal, registry: namespaces }),
swarm, api: createApiRegistryClient(...), mcp: createMcpRegistryClient(...),
fs, sh, stdlib, logger: console,
```
(`:58-65`)

- `swarm` is `createSwarmSdk(swarmConfig, {signal})` plus `config`.
- `fs` and `sh` come from `createScriptFs(agentFs, signal)`.
- Native passes no `signal` (`eval-harness.ts:112-117`). QuickJS passes the host run signal (`quickjs-runner.ts:542-549`).
- Neither executor passes any object target or identity beyond `swarmConfig`, the connections and `agentFs`.

#### Gaps

- I did not read `resolveScriptExecutor`, `isExecutorAllowedByDeployment`, or the quickjs executor wrapper that calls `runQuickJSJob`. These are the pool and worker plumbing around it.
- I did not read `quickjs-prelude.ts:1-470`, so the guest-side ctx proxy construction is unconfirmed beyond the `define("__swarm_ctx", ctx)` line.
- I did not read `structuredError` (`quickjs-runner.ts:343`) or `errorStderr`.
- I did not read `host-validated-args.ts` and did not confirm that the epilogue's copy of the helpers is identical.
- I did not read the warm-harness spare logic (`native.ts:328-391`) beyond the grep hits.
### 2. script_upsert, typecheck and signature extraction

#### Upsert entry points (MCP tool to HTTP)

The MCP tool `script-upsert` does no work itself. It validates its input and proxies the call over HTTP.
- Input fields are `name`, `source`, `description`, `intent`, `scope` (default `agent`), `fsMode` (default `none`) and `executor` (`src/tools/script-upsert.ts:23-43`).
- The handler calls `proxyScriptsApi({ method: "POST", path: "/api/scripts/upsert", body: args, ... })` (`src/tools/script-upsert.ts:46-50`).
- The success message reads `version` and `contentDeduped` from the response body (`src/tools/script-upsert.ts:59-64`).

```ts
proxyScriptsApi({
  method: "POST",
  path: "/api/scripts/upsert",
  body: args,
```

The HTTP body schema `upsertBodySchema` has the same fields (`src/http/scripts.ts:67-75`). The handler order in `handleScripts` is below (`src/http/scripts.ts:659-751`).
1. Requires an agent through `requireAgent`.
2. `scope: "global"` needs `can(... "script.global.write")`, which returns 403 for a non-lead (667-678).
3. Rejects `executor` when `isExecutorAllowedByDeployment` fails (680).
4. Rejects source with embedded secrets via `refuseSourceWithSecrets` (689).
5. Calls `typecheckScript(source, { agentId })`. A failure returns 400 `{error:"typecheck_failed", diagnostics, structured}` (695-707).
6. Resolves the audit user with `resolveHttpAuditUserId`.
7. Runs `extractArgsJsonSchema(source)` (715).
8. Computes `signatureJsonFor(source)` (723) and calls `upsertScriptByName` with `isScratch: false, typeChecked: true`.
9. Emits a global-upsert event only for global scope when `!result.contentDeduped` (733).
10. Responds `{name, version, contentDeduped, warnings?}`. The warnings come from `checkQuickJSCompat` (742-750).

Other writers call the same typecheck, extraction and upsert steps. They are seed scripts (`src/be/seed-scripts/index.ts:456-472`), directory import (`src/be/import/dir-source.ts:284-294`) and extensions (`src/be/extensions/assets.ts:325-337`).

Inline `script_run` auto-saves a scratch script with `typeChecked: false` and `isScratch: true`. It writes `signatureJson` but passes no `argsJsonSchema` (`src/http/scripts.ts:880-894`).

#### DB write, versions, hash

`upsertScriptByName` (`src/be/scripts/db.ts:187`) first calls `getScript({name, scope, scopeId})`. The lookup is a `name + scope + scopeId` match (335-349). `scopeId` is null for global scope, and agent scope requires it (57-63). A unique index backs this: `idx_scripts_name_scope ON scripts(name, scope, COALESCE(scopeId,''))` (`src/be/migrations/064_scripts.sql:20`).

- **New script (190-199).** `insertScript` runs in a transaction. It inserts a `scripts` row with `version` taken from the column default of 1 (`064_scripts.sql:11`). It then inserts a `script_versions` row with `changeReason` "Initial creation" (120-179).
- **Content hash.** `computeContentHash` is SHA-256 hex of the source (`src/be/db/context-versions.ts:4-8`). The same hash is stored in `scripts.contentHash` and `script_versions.contentHash`.
- **Same hash as the existing row (202-269).** No new version is created. If metadata or flags changed, it runs `UPDATE scripts` for `description`, `intent`, `signatureJson`, `argsJsonSchema`, `isScratch`, `typeChecked`, `fsMode` and `executor`. It returns `contentDeduped: true`. It re-embeds only if tracked metadata changed or a scratch script was promoted.
- **Different hash (271-333).** `newVersion = existing.version + 1`. In one transaction it updates the `scripts` row (source, hash, version and the other fields) and inserts a new `script_versions` row.
- `script_versions` has `UNIQUE(scriptId, version)` and an index on `contentHash` (`064_scripts.sql:36-39`).
- `insertScriptVersion` writes `source, description, intent, signatureJson, contentHash, changedByAgentId, changedAt, changeReason`. It does not write `argsJsonSchema` (`db.ts:98-117`).

```ts
const contentHash = computeContentHash(args.source);
if (existing.contentHash === contentHash) {
```

Non-scratch scripts are embedded synchronously through `embedScript` (192, 324). The embedding text is `description + intent + signatureJson`, scrubbed (`src/be/scripts/embeddings.ts:57-59`).

#### pinHash

`pinHash` appears only on the workflow `swarm-script` node (`src/workflows/executors/swarm-script.ts:32`, `src/types.ts:2794`). A pin is a content hash, not a version number. `resolveScriptSource` calls `getScriptVersion({scriptId, contentHash: pinHash})` (249). That query is `WHERE scriptId=? AND contentHash=? ORDER BY version DESC LIMIT 1` (`db.ts:382-385`). A miss returns the error `pinHash '...' not found` (250-255). On a hit the source and version come from the `script_versions` row (257-263).

```ts
const version = await getScriptVersion({ scriptId: script.id, contentHash: config.pinHash });
```

#### Typecheck

`typecheckScript` (`src/be/scripts/typecheck.ts:1590-1611`) builds the ambient types from three contributors:
- `getScriptApiTypes(context)`
- `getScriptMcpTypes(context)`
- `await getScriptAppTypes(context)`

The `ScriptTypeContributor` type and `ScriptTypeContext {agentId?, repoId?}` are in `src/be/scripts/type-contributors.ts:6-24`. `scriptSdkTypesWithGeneratedApis` concatenates `SCRIPT_SDK_TYPES` with those fragments (939-947). The stdlib module is the static `SCRIPT_STDLIB_TYPES` unless app types exist, in which case it is `scriptStdlibTypesWithGeneratedApis` (1598-1600). Both are passed as virtual modules `"swarm-sdk"` and `stdlib`.

`ScriptMain` is declared at `typecheck.ts:936`:

```ts
export type ScriptMain = (args: any, ctx: ScriptContext) => unknown | Promise<unknown>;
```

The check file is appended as `/virtual/check.ts` (1604-1609):

```ts
import run from "./user-script";
import type { ScriptMain } from "swarm-sdk";
const _scriptMain: ScriptMain = run;
void _scriptMain;
```

`typecheckWithAmbient` (1530-1588) builds a virtual file map from `USER_FILE`, `RUNTIME_GLOBALS_FILE` and `CHECK_FILE`. The compiler options are `strict`, `noEmit`, `lib es2022`, `moduleResolution Bundler`. Only diagnostics whose file is `USER_FILE` or `CHECK_FILE` are kept (1568-1571). The result is `{ok:true}` or `{ok:false, diagnostics: string[], structured: ScriptDiagnostic[]}` (28-30). `diagnostics` are formatted with `ts.formatDiagnosticsWithColorAndContext`. `structured` entries carry `severity, code, message, file, line, column, endLine, endColumn, identifier, suggestion` (1499-1527). `suggestion` is parsed from "Did you mean 'x'?" text (1492-1497).

#### Signature extraction

`extractScriptSignature(source)` (`src/scripts-runtime/extract-signature.ts:50-81`) parses the source with `ts.createSourceFile`. It returns `FALLBACK_SIGNATURE` (`{argsType:"unknown", resultType:"unknown", description:""}`) on parse diagnostics, on an exception, or when no recognised shape is found. It scans top-level statements for two shapes:
- `export default function ...`, a `FunctionDeclaration` with a `default` modifier (65-67).
- `export default <arrow | function expression>`, an `ExportAssignment` (69-74).

No other shape is recognised: not `export default class`, not a default-exported identifier, and not a named export.

The output has three fields (`fromFunctionLike`, 31-41):
- `argsType` is the source text of the first parameter's type annotation, or `"unknown"`.
- `resultType` is the return type text with one outer `Promise<...>` stripped (23-29), or `"unknown"`.
- `description` is the first JSDoc comment on the function (15-21).

It is stored as `JSON.stringify(...)` into `signatureJson` (`src/http/scripts.ts:602-604`).

#### argsSchema extraction (sandboxed)

`extractArgsJsonSchema` (`src/be/scripts/extract-schema.ts:22-66`) writes the source into a tmpdir. It spawns `bun run extract-args-schema.ts` through `buildSandboxedCommand` (ulimit sandbox) with a 5s kill timeout (13, 44-51). The env vars are `SWARM_SCHEMA_SOURCE_FILE`, `SWARM_SCHEMA_RESULT_FILE` and `SWARM_SCHEMA_TMPDIR`. Any non-zero exit or exception returns `null` (55, 61-62).

The subprocess `src/scripts-runtime/extract-args-schema.ts`:
- Creates `node_modules` shims for `stdlib`, `swarm-sdk`, `zod` and `zod/mini` (13-43).
- Imports the user module and reads the named export `argsSchema` (75).
- Calls `toJSONSchema(mod.argsSchema, { io: "input" })` and writes it as JSON (83-84).
- Writes `"null"` if the import fails or there is no object-typed `argsSchema` (66-78).
- Never reads `mod.default`.

```ts
const schema = toJSONSchema(mod.argsSchema as any, { io: "input" });
```

#### Where the columns are read

- `GET /api/scripts/{id}` returns `{...script, signature: JSON.parse(signatureJson), argsJsonSchema: parsed|null}` (`src/http/scripts.ts:1016-1035`).
- `GET /api/scripts/{name}/types` returns `signature`, `argsJsonSchema`, `sdkTypes` and `stdlibTypes`. It resolves the script with `resolveScript` and regenerates the types per agent (1048-1070).
- The `script-query-types` tool calls `/api/scripts/type-defs` when there is no name. With a name it calls `/api/scripts/{name}/types` (`src/tools/script-query-types.ts:55-74`). `renderTypeBlobs` prints the four blobs (14-36).
- `embeddings.ts:58` reads `signatureJson`. `argsJsonSchema` is only carried on the candidate row (24-25, 71).
- Other readers:
  - `src/ui-spec/script-actions.ts:117-126` validates action args.
  - `src/http/x.ts:219-221` validates endpoint args.
  - `src/be/scripts/user-code-mode.ts:27-29, 67-69`.
- `src/be/scripts/boot-args-schema.ts:73-89` is a post-listen backfill. It rewrites normalized `argsJsonSchema` where `contentHash` and the old value still match.

#### Loading a saved script for execution

- **`/api/scripts/run` (`src/http/scripts.ts:783-793`).** `resolveScript(name, agentId, scope)` tries agent scope first, then global (606-616). It uses the row's current `source`, `fsMode` and `executor`. There is no version or pin parameter. Request-level `executor` overrides the stored one. `runScriptWithRunCredential` then receives `source`.
- **Workflow `swarm-script` (`src/workflows/executors/swarm-script.ts:221-264`).**
  - **Scope.** `config.scope === "global"` looks up global only. `"agent"` looks up agent scope with the run's agent id. Unset tries agent, then global, when an agent id exists, and global only otherwise.
  - **Version.** With no `pinHash` it uses the latest `scripts.source`. With `pinHash` it uses the pinned `script_versions` row.
  - **Executor.** `fsMode` is hard-coded to `"none"` and `executor` comes from `resolved.script.executor` (137).
- **Other callers.** They look up global scripts by name: scheduler (`src/scheduler/scheduler.ts:87`), heartbeat (`src/heartbeat/heartbeat.ts:1762`) and follow-up gate (`src/tasks/follow-up-gate.ts:86`). Others look up by id: apps (`src/apps/action-runner.ts:62`) and the `/x` endpoints (`src/http/x.ts:204`).
- **Runtime export check.** The harness requires `typeof mod.default === "function"`, validates `argsSchema` if present, then calls `mod.default(validatedArgs, ctx)` (`src/scripts-runtime/eval-harness.ts:132-168`).

#### Gaps

- I did not read `refuseSourceWithSecrets`, `checkQuickJSCompat` or `emitGlobalUpsertEvent`. I only confirmed where they are called.
- I did not check whether `listScriptVersions` or the version-history route exposes `signatureJson`. `src/types.ts:3994` shows `signatureJson` on the version record schema.
- I did not read the `scripts.argsJsonSchema` and `executor` column migrations (not in `064_scripts.sql`).
- I did not trace `runScriptWithRunCredential` into `loader.ts` to see how `source` becomes the module file. I only confirmed the harness call at `eval-harness.ts:168`.
- I did not read `getScriptAppTypes` (`src/apps/script-types.ts`) or `getScriptApiTypes` and `getScriptMcpTypes` (`src/be/script-connections.ts`). Their content and filtering are unconfirmed.
### 3. KV internals, reserved families and write guards

#### KV table and row shape

- `kv_entries` is `WITHOUT ROWID` with primary key `(namespace, key)`. `value` is TEXT. `value_type` is one of `json`, `string`, `integer`. `expires_at` and `created_at`/`updated_at` are unix-ms integers (`src/be/migrations/061_kv_store.sql:20-30`).
- Migration 082 added nullable `created_by` and `updated_by` columns that reference `users(id)` (`src/be/migrations/082_user_audit_fields.sql:76-77`).
- None of the KV functions in `db.ts` read or write those two columns. Every SELECT and RETURNING lists only `namespace, key, value, value_type, expires_at, created_at, updated_at` (`src/be/db.ts:13951-13953`).

```sql
PRIMARY KEY (namespace, key)
) WITHOUT ROWID;
```

#### db.ts KV functions (`src/be/db.ts:13922-14293`)

- `encodeKvValue(value, valueType)` (13922): `json` is `JSON.stringify`. `integer` takes a safe-integer number or a `/^-?\d+$/` string. `string` requires a string. Any other input throws.
- `getKv(namespace, key): Promise<KvEntry | null>` (13950): one SELECT through `getDbClient().get`. If `expires_at <= Date.now()`, it deletes that row inline and returns null.
- `upsertKv({namespace,key,value,valueType,expiresAt?}): Promise<KvEntry>` (14021): `INSERT ... ON CONFLICT(namespace,key) DO UPDATE ... RETURNING`. On conflict it overwrites `value`, `value_type`, `expires_at` and `updated_at`. It keeps the original `created_at`. It runs as one client call with no explicit transaction. It does not check the existing `value_type`.
- `claimKv(same input): Promise<boolean>` (14053-14075):
  - It runs the same INSERT with the conflict update guarded by `WHERE kv_entries.expires_at IS NOT NULL AND kv_entries.expires_at <= ?` (bound to `now`).
  - It inserts if the key is absent, and overwrites only if the existing row is expired.
  - It returns `result.changes > 0`. That is true if it created or refreshed the row, and false if a live row exists.
  - It is a single `getDbClient().run`, with no transaction wrapper.
- `deleteKv(namespace,key): Promise<boolean>` (14081): plain DELETE, returns `changes > 0`. It does not tell expired rows from missing ones.
- `incrKv(namespace,key,by): Promise<KvEntry>` (14104):
  - It requires a safe integer `by`.
  - It runs inside `getDbClient().transaction(async (tx) => ...)`. Per CLAUDE.md that is `BEGIN IMMEDIATE`. The BEGIN mode itself lives in the client, not here.
  - A missing or expired row is upserted with `String(by)`, type `integer` and `expires_at` NULL.
  - A non-integer existing type throws `KvTypeCollisionError`. The HTTP layer maps that to 409 (`src/http/kv.ts:668`).
  - Otherwise it UPDATEs `value` and `updated_at` only, so the existing TTL is kept.
  - It checks for safe-integer overflow.
- `listKv(namespace, {prefix?, limit, offset, jsonFieldEquals?, keyAfter?, keyThrough?}): Promise<KvEntry[]>` (14237):
  - It filters `(expires_at IS NULL OR expires_at > now)`, orders by `key`, and applies LIMIT/OFFSET.
  - The prefix is a range over the primary key (`kvPrefixUpperBound`, 14169).
  - It does not delete expired rows.
- `sweepExpiredKv(namespace)` (13969) and `sweepExpiredKvPrefix(prefix)` (13983, batches of at most 50, yielding with `setImmediate`) delete expired rows. `countKv` (14282) counts live rows.

```ts
WHERE kv_entries.expires_at IS NOT NULL AND kv_entries.expires_at <= ?`,
```

#### Who calls claimKv today (non-test)

- `src/agentmail/inbound-archive.ts:64`: inbound archive, JSON value with a TTL.
- `src/integrations/kapso/config.ts:102`: message dedupe, integer value 1 with a TTL.
- `src/slack/session-mirror.ts:71`: string timestamp with a TTL.
- `src/slack/external-channel.ts:219`: value `"sending"` with a TTL.
- `src/comb/review-batch.ts:328`: `{status:"pending",claim}` with `PENDING_CLAIM_MS`.

All five pass `expiresAt`, so each claim is a TTL lease.

```ts
value: { status: "pending", claim },
expiresAt: Date.now() + PENDING_CLAIM_MS,
```

#### Reserved namespaces (`src/kv-reserved-namespaces.ts`)

- `RESERVED_FAMILIES` is a `Map<familyName, errorMessage>` (7-29). The entries are `apps`, `comb`, `design-system`, `heartbeat-checklist`, `worker`, `slack-external-alert`, `slack-left-thread`, `slack-thread-buffer` and `session-labels`.
- Matching is by the first segment: `reservedNamespaceError(ns)` returns `RESERVED_FAMILIES.get(ns.split(":",1)[0])` or null (55-57). A family `x` covers `x` and `x:*`.
- `PRIVATE_FAMILIES` is `session-labels` and `slack-thread-buffer` (37). `privateNamespaceError` blocks generic reads of these (60).
- `LEAD_ONLY_FAMILIES` is `usecase` (44), checked by `requiresLeadToWrite` (47).
- `reservedRoomKeyError(key)` rejects any key starting with `_room/` (66-70).

```ts
return RESERVED_FAMILIES.get(namespace.split(":", 1)[0] ?? "") ?? null;
```

#### Internal writers of reserved namespaces

- **Apps** (`src/apps/row-store.ts`): `appsNamespace(appId)` is `apps:${appId}` (74). Row keys are `${model}/row/${rowId}` (78). Index keys are `${model}/idx/${column}/${encoded}/${rowId}` (94-96). It calls `upsertKv`, `getKv`, `listKv` and `deleteKv` directly (1, 237, 345, 497). It also uses raw SQL for keyset paging (423) and batch purge (597). `src/apps/sync.ts:110` stores `sync-status:<model>:<source>` keys in the same namespace.
- **Rooms** (`src/realtime/rooms.ts`): the key is `_room/<name>` (`ROOM_KEY_PREFIX` at 14, `roomKey` at 82). The namespace is caller-supplied, for example a page namespace (`pageIdForNamespace`, 102).
  - The flush (483-507) opens `getDbClient().transaction` and checks that the page row still exists.
  - It then runs a raw `INSERT INTO kv_entries ... 'json', NULL ... ON CONFLICT DO UPDATE` instead of `upsertKv`. That insert forces `expires_at = NULL`.
  - Loading reads the row by raw SQL (310). Listing room names uses `key LIKE '\_room/%'` (332).
  - `_room/` is blocked for generic writes only through `reservedRoomKeyError`. The namespace itself is not reserved.
- **Design system** (`src/be/design-system.ts`): namespace `design-system`, keys `org` and `org.prev` (`src/themes/design-system.ts:17-20`). `saveDesignSystem` runs inside `getDbClient().transaction`. It reads `org`, copies it to `org.prev` with `upsertKv` if present, then `upsertKv`s the new `org` (45-62).

```ts
export function appsNamespace(appId: string): string {
  return `apps:${appId}`;
}
```

#### Write and read auth (duplicated)

- **MCP** `kvWriteAuthError(namespace, {agentId}, key?)` (`src/tools/kv/kv-write-auth.ts:20-69`) checks in this order:
  1. `reservedRoomKeyError`.
  2. `reservedNamespaceError`.
  3. `mcpOverflowAuthError`.
  4. A `task:page:` prefix, which is always denied.
  5. `requiresLeadToWrite`, which goes through `can({verb:"kv.write.any", source:"mcp"})`.
  6. A `task:agent:` prefix, which goes through `can()` and skips the agent lookup for the caller's own namespace.
- **HTTP** `authorizeWrite(namespace, ctx)` (`src/http/kv.ts:369-419`) runs the same checks and returns `{status:403,message}`. Differences from the MCP version:
  - It does not check the room key. `reservedRoomKeyError` is called separately after `authorizeWrite` in `sendPut` (722), `sendDelete` (764) and the incr handler (656).
  - `task:page:*` is allowed when `X-Page-Id` is present (`hasPageHeader`).
  - `isLead` comes from `buildAuthCtx` (346-355).
  - It uses `source:"http"`.
- **Read auth** is the same on both surfaces: `privateNamespaceError(ns) ?? mcpOverflowAuthError(ns, agentId)` (`src/tools/kv/kv-read-auth.ts:14`, `src/http/kv.ts:425-427`). Ordinary namespaces are readable across agents.

```ts
const reservedErr = reservedNamespaceError(namespace);
if (reservedErr) {
  return { status: 403, message: reservedErr };
```

#### Namespace resolution

- **MCP** `resolveNamespace(explicit, info)` (`src/tools/kv/resolve-namespace.ts:25-58`): use the explicit value, else the `sourceTaskId` task's `contextKey`, else `agentContextKey({agentId: task.agentId})`, else `agentContextKey({agentId: info.agentId})`, else return an error.
- **HTTP** `resolveNamespaceFromHeaders` (`src/http/kv.ts:303-338`): `x-page-id` gives `pageContextKey`. Then `x-source-task-id` gives the task's `contextKey` or its agent's key. Then `x-agent-id` gives the agent key. Otherwise null. Explicit-path routes bypass this.
- `agentContextKey` yields `task:agent:<id>` (per the doc comment at `resolve-namespace.ts:14`).

```ts
if (task?.contextKey) {
  return { namespace: task.contextKey, source: "task" };
}
```

#### Gaps

- I did not read `getDbClient().run/get` in `src/be/db-client`. I did not confirm whether a single `run` takes `BEGIN IMMEDIATE`, or where the `BEGIN IMMEDIATE` is issued.
- I did not read `decodeKvRow`, the `KvEntry` type, or `kvKeyAfter` in `src/be/db/kv-windows.ts`.
- I did not confirm how `created_by`/`updated_by` get populated, if at all (for example by triggers). No KV code path writes them.
- I did not read `agentContextKey`, `pageContextKey` or `mcpOverflowAuthError` bodies.
- I did not read the `kv-set` / `kv-incr` tool bodies, or the HTTP handlers at 549-612 and 779+ (list, and the route dispatch).
- I did not read the other claim callers' surrounding code, such as how comb and external-channel release or refresh their leases.
### 4. Durable script run finish paths, afterCommit and the event bus

#### Overview
Durable script runs live in the `script_runs` table. A supervisor (`src/script-workflows/supervisor.ts`) spawns a sandboxed harness subprocess. The final status reaches the database through an HTTP callback, a supervisor exit handler, or a cancel/limit path. None of the `updateScriptRun*` writers emits a bus event or calls `afterCommit`.

#### Terminal-status writers
All writes go through `scriptRunUpdateSets` and one of three exported functions. `src/be/db.ts:14639` is the plain `updateScriptRun`. `:14657` is `updateScriptRunIfNotTerminal`. `:14674` is `updateScriptRunIfRunning`.

```ts
return await updateScriptRunGuarded(id, patch, "status = 'running'");
```
`src/be/db.ts:14678`

Every path that sets a terminal status:
- **completed, via the harness result.** The executor's `exited` handler reads `resultFile` and calls `postStatus(... {status:"completed", output})` (`src/script-workflows/executor.ts:433-434`). The status route handles it with `updateScriptRunIfRunning` (`src/http/script-runs.ts:679`).
- **failed, via the harness error.** A non-zero exit, a protocol failure, or a bad result file posts `{status:"failed", error}` (`executor.ts:436-444`). The same route handles it.
- **completed or failed, via the supervisor.** `startScriptRunProcess` has an `exited.then` handler. If the run is still `running`, it calls `updateScriptRunIfRunning` with `completed` for exit 0, else `failed` (`supervisor.ts:60-85`). It returns early when `terminated` is set (`supervisor.ts:62`).
- **failed, on spawn error.** Two sites do this: `reconcileScriptRuns` (`supervisor.ts:136-142`) and the POST launch handler (`src/http/script-runs.ts:511-518`). Both use plain `updateScriptRun`.
- **cancelled.** `DELETE /api/script-runs/{id}` calls `terminateScriptRunProcess`, then `updateScriptRunIfNotTerminal` (`src/http/script-runs.ts:583-591`). If the run is already terminal, it returns 204 without a write (`:578-582`).
- **aborted_limit.** `abortScriptRunLimit` (`supervisor.ts:113-121`) is called from three places:
  - the wall-clock check in `reconcileScriptRuns` (`supervisor.ts:128-134`)
  - the step-count check in `assertRunWithinLimits` (`src/http/script-runs.ts:420-423`)
  - the agent-task-count check in `assertRunWithinLimits` (`src/http/script-runs.ts:428-431`)
- **paused, not terminal.** `pauseScriptRunProcess` (`supervisor.ts:108-111`) and a `paused` status POST write it. `finishedAt` stays null for paused (`script-runs.ts:682`).

#### Status route and result storage
The status body is a discriminated union: `completed` takes optional `output`, `failed` takes optional `error`, and `paused` takes neither (`src/http/script-runs.ts:99-103`). The handler returns 204 without writing when `run.status !== "running"` (`:672-676`). The result is stored in the `output` column (there is no `result` column). `error` is stored too.

```ts
output: "output" in parsed.body ? parsed.body.output : undefined,
```
`src/http/script-runs.ts:683`

`scriptRunUpdateSets` scrubs `output` with `scrubJsonValue` and `error` with `scrubSecrets` (`src/be/db.ts:14620-14627`). Inline runs go through `recordInlineScriptRun` and are inserted already terminal (`db.ts:14435-14490`).

#### Crash, heartbeat and reconcile
- The executor POSTs `/heartbeat` every 10s (`executor.ts:400-405`). The route writes `last_heartbeat_at` with plain `updateScriptRun` (`script-runs.ts:658`).
- `startScriptRunSupervisor` runs `reconcileScriptRuns` immediately and then every 15s (`supervisor.ts:148-155`). It is wired at `src/http/index.ts:924`.
- Reconcile scans `getRunningScriptRuns`, which returns `running` and `paused` rows (`db.ts:14696-14701`). It relaunches a run with no managed handle and no live pid (`supervisor.ts:135`). I found no heartbeat-staleness check there. The heartbeat timestamp is only written.
- On API shutdown, `stopScriptRunSupervisor` terminates managed runs (`supervisor.ts:157-161`). The executor leaves the status as `running` so the next supervisor replays the journal (`executor.ts:417-419`).
- Wall-clock limit: `SCRIPT_RUN_MAX_WALL_MS` defaults to 24h (`src/script-workflows/limits.ts:2,16-18`).

#### Harness entry
Only a default function export runs.

```ts
if (typeof mod.default !== "function") {
  throw new Error("Script workflow must export a default function");
}
```
`src/script-workflows/harness.ts:65-67`

It then calls `mod.default(args, ctx)` and writes the result file (`harness.ts:74-75`). The harness never posts the status itself. The executor does that after the process exits.

#### Launch route, MCP tool and SDK shape
`POST /api/script-runs` does the following, in order:
- Refuses a source that contains secrets (`script-runs.ts:450`).
- Lints loop-step labels (`:456`).
- Returns 409 with the existing run when the `idempotencyKey` matches (`:470-480`).
- Resolves `sourceTaskId` and `requestedByUserId` (`:485-489`).
- Runs the concurrency cap check and `createScriptRun` in one transaction (`:490-503`). The cap is checked via `countActiveScriptRuns`, which counts `running` and `paused` rows (`db.ts:14582`).
- Calls `startScriptRunProcess` when `background` is true (`:510-519`).

The body is `{source, args?, background (default true), idempotencyKey?, scriptName?, requestedByUserId?}` (`:72-79`). The `launch-script-run` MCP tool proxies to this route with `background: true` (`src/tools/script-runs.ts:109-114`). `ctx.swarm.script_launchRun` has the same arg shape, without `background` (`src/scripts-runtime/types/swarm-sdk.d.ts:883-889`). The tool maps to it in `src/scripts-runtime/sdk-allowlist.ts:80`.

#### script_runs columns
- **083** creates the base columns (`src/be/migrations/083_script_workflows.sql:3-28`): `id`, `agentId`, `scriptName`, `source`, `args`, `status` (CHECK of 6 values), `pid`, `startedAt`, `finishedAt`, `output`, `error`, `last_heartbeat_at`, `idempotencyKey` (UNIQUE), `requestedByUserId`, `created_by`, `updated_by`.
- **084** touches `script_run_journal` only (`durationMs`).
- **085** adds `kind` (`workflow` or `inline`, default `workflow`) (`085_script_runs_kind.sql:5-7`).
- **088** adds list indexes.
- **102** adds `apiEndpointId` (`102_script_apis.sql:31`).
- **266** adds `sourceTaskId` and `followUpGuard` (`266_script_runs_source_task.sql:5,11`).
- **293** adds `sourceStepId` and `parentScriptRunId` (`293_savings_component_links.sql:18-19`).
- **342** adds `sourceHash` plus the `script_run_sources` table and a delete trigger (`342_script_run_sources.sql:3-20`).

`createScriptRun` inserts `source` as `''` plus `sourceHash` (`db.ts:14404-14408`). It does not write `sourceStepId` or `parentScriptRunId`. Only `recordInlineScriptRun` writes those two (`db.ts:14459-14485`). `ScriptRunSchema` does not list them (`src/types.ts:3774-3793`).

#### afterCommit implementation
`DbClient.afterCommit` is declared at `src/be/db-client.ts:120`.

```ts
if (ctx && !ctx.closed) { ctx.afterCommit.push(fn); return; }
this.scheduleHook(fn);
```
`src/be/db-client.ts:574-579`

- Inside a transaction, the hook is queued and dropped on rollback.
- After COMMIT, queued hooks each go to `scheduleHook` (`db-client.ts:548`).
- Outside a transaction, the hook is scheduled immediately.
- `scheduleHook` waits on the FIFO lock, then releases it and runs `fn` (`:593-596`).
- A sync throw or an async rejection is only logged, as `[db-client] afterCommit hook threw/rejected` (`:598-603`).

#### workflowEventBus
- It is defined at `src/workflows/event-bus.ts:71` as `new InProcessEventBus(realtimeBus)`.
- The API is `emit`, `on`, `off`, `onPrefix` and `offPrefix` (`:6-17`).
- `emit` scrubs top-level string fields (`:27`). It then calls `bus.publish("workflow:<event>")` and any prefix handlers synchronously (`:28-32`).
- `InProcessBus.publish` is a Node `EventEmitter.emit` (`src/realtime/bus.ts:13-15`). Handlers run synchronously and no `try/catch` wraps the emit. Async listeners, such as the ones in `src/workflows/resume.ts`, use their own `try/catch`.
- Event names I found in use:
  - `task.created`, `task.completed`, `task.failed`, `task.cancelled`, `task.skipped`, `task.superseded`, `task.progress`, `task.unassigned`, `task.create_blocked`, `task.budget_refused`
  - `approval.resolved`
  - `workflow.child.finished`
  - `slack.message`
  - `chat.message.received`, `chat.message.sent`
  - `agentmail.message.received`, `kapso.message.received`
  - `azure-devops.work_item.*`
  - VCS prefixes such as `github.`
- Listeners include `src/workflows/resume.ts:122-186`, `src/extensions/post-bridge.ts:366-380`, `src/jira/outbound.ts:67-70` and `src/slack/render-v2.ts:2256`.
- I found no `script_run.*` event name emitted or subscribed.

#### Two afterCommit + emit pairs
1. Task created (`src/be/db.ts:3154-3165`). The emit is deferred and uses a dynamic import:
```ts
getDbClient().afterCommit(() => {
  import("../workflows/event-bus").then(({ workflowEventBus }) => {
    workflowEventBus.emit("task.created", {
```
2. Workflow child finished, through `emitBusEventAfterCommit` (`src/be/db/workflow-runs.ts:689-702`). It is used by `emitAfterCommit` at `:661-662` for `workflow.child.finished`, and for `WORKFLOW_RUN_FINISHED_EVENT` at `:686`. A third, simpler pair is at `src/ui-spec/script-actions.ts:335-336`: `afterCommit(() => workflowEventBus.emit(TASK_UI_SPEC_UPDATED_EVENT, {taskId}))`.

#### Gaps
- I did not read `guest-ctx.ts` or `workflow-ctx.ts` in full. I only confirmed their HTTP calls to `/steps`, `/agent-task` and `/status`, so I cannot say whether they have other terminal paths.
- I did not find where the `paused` state resumes. The reconcile code only skips `paused` runs, and I did not trace the resume trigger.
- I did not trace `followUpGuard` writes or `rowToScriptRun`'s handling of `sourceStepId` and `parentScriptRunId`.
- Migrations 254 and 319 touch `script_runs` only for indexes. I did not read them in full.
- I did not confirm that `workflow.child.finished` is the only run-terminal bus event. `WORKFLOW_RUN_FINISHED_EVENT`'s literal value is unread.
### 5. Run provenance, parent chain and per-run credential

#### Credential mint and revoke: `runScriptWithRunCredential`

`runScriptWithRunCredential` (`src/be/scripts/run-credential.ts:81-91`) calls `acquireScriptApiCredential`, then `runScript({...input, apiKey})`, and calls `credential.release()` in a `finally`. The release therefore happens on success, throw, timeout or abort.

`acquireScriptApiCredential` (`:54-71`) looks up `getAgentById(agentId)`. If no agent exists, it returns `{apiKey: undefined, release: noop}`. Sentinel ids such as `"schedule"` and `"workflow"` take this path (`:50-52` comment; `swarm-script.ts:138` passes `agentId ?? "workflow"`). With `apiKey` undefined, `runScript` falls back to the swarm API key. For a real agent, it calls `mintScriptRunToken(agentId, SCRIPT_RUN_TOKEN_TTL_MS, provenance)`.

The TTL is 15 minutes, as a backstop. `release` is idempotent and calls `revokeSessionToken(token.tokenId)`.

A separate path, `runScriptAsUserWithRunCredential` (`:99-130`), mints a user-bound token. It passes `agentId: ""` and empty bindings.

```ts
const SCRIPT_RUN_TOKEN_TTL_MS = 15 * 60 * 1000;
...
const token = await mintScriptRunToken(agentId, SCRIPT_RUN_TOKEN_TTL_MS, provenance);
```

#### Token columns: `mintScriptRunToken` and resolution

`mintScriptRunToken` (`src/be/users.ts:746-771`) calls `insertSessionToken(agentId, null, null, ttlMs, null, undefined, null, null, true)`. The final `true` sets the `scriptRun` marker. The task and runtime ids are null, so it resolves as a plain agent token.

If provenance is present, it then runs `UPDATE session_tokens SET sourceStepId = ?, sourceScriptRunId = ? WHERE id = ?` before returning the plaintext (`:764-769`). `isScriptRunToken` reads `scriptRun` (`:774-780`).

The columns `sourceStepId` and `sourceScriptRunId` come from migration 293 (`src/be/migrations/293_savings_component_links.sql:12`).

Resolution (`users.ts:1062-1119`):
- It selects `s.sourceStepId, s.sourceScriptRunId` (`:1078-1079`).
- It returns null if the token is revoked or `expiresAt <= now` (`:1083-1084`).
- It updates `lastUsedAt` unless `touch` is false.
- It adds the two provenance fields to the result only when at least one is set (`:1116-1118`).

```ts
...(row.sourceStepId || row.sourceScriptRunId
  ? { sourceStepId: row.sourceStepId, sourceScriptRunId: row.sourceScriptRunId }
  : {}),
```

#### Request context: `getCurrentRunProvenance`

The request context is an `AsyncLocalStorage<RequestAuthSlot>` (`src/utils/request-auth-context.ts:52`). The slot is a mutable `{auth}` object. `beginRequestAuthScope()` installs it synchronously with `enterWith` (`:59-61`). `setRequestAuth` fills it in after auth resolution (`:63-68`).

The `agent` variant of `HttpRequestAuth` carries optional `sourceStepId` and `sourceScriptRunId` (`:25-31`).

`getCurrentRunProvenance` (`:116-122`) returns null unless `auth.kind === "agent"`. It returns `{sourceStepId, sourceScriptRunId}` only if at least one is set. The doc comment says async work started inside the request inherits it.

```ts
if (auth?.kind !== "agent") return null;
...
return sourceStepId || sourceScriptRunId ? { sourceStepId, sourceScriptRunId } : null;
```

#### Nested `script_run` flow

1. `swarm-sdk.ts:247-248` maps `script_run` to `POST /api/scripts/run`. The headers (`:25-27`) are `Authorization: Bearer <config.apiKey>` plus `X-Agent-ID` when the agent id is non-empty. The apiKey is the per-run token.
2. In the handler (`src/http/scripts.ts:816-840`), `runId = crypto.randomUUID()` is fixed up front. `callerProvenance = getCurrentRunProvenance()` reads the caller's token provenance. The new run's token is minted with `{sourceScriptRunId: runId, sourceStepId: callerProvenance?.sourceStepId}`.
3. After execution, `recordInlineScriptRun` is called with `id: runId` (`scripts.ts:915-929`). It does not pass provenance explicitly. Inside `db.ts:14455`, it reads `getCurrentRunProvenance()` and writes `sourceStepId` and `parentScriptRunId` (`db.ts:14483-14484`). `parentScriptRunId` is the caller token's `sourceScriptRunId`.

So nested rows record the caller's run id as parent and inherit its step id. The child's own token carries `sourceScriptRunId = runId`, so a grandchild's parent is the child.

```ts
// A run called through another script run's token (a nested
// ctx.swarm.script_run) records that run and its workflow step.
provenance?.sourceStepId ?? null,
provenance?.sourceScriptRunId ?? null,
```

#### Run rows and run kinds

`ScriptRunKindSchema = z.enum(["workflow", "inline"])` (`src/types.ts:3771`).
- `recordInlineScriptRun` inserts `kind = 'inline'`, already terminal (`db.ts:14432-14464`). The insert is wrapped in try/catch and failures are swallowed (`scripts.ts:930-932`).
- `/api/scripts/run` covers both named and inline-source runs. It resolves a named script, which may be scratch (`scripts.ts:783-793`), and then records an inline row either way. So a row exists for scratch, named and inline runs on that route. Other callers of `recordInlineScriptRun`: `src/http/x.ts:287`, `src/scheduler/scheduler.ts:171` and `src/be/scripts/user-code-mode.ts:117`.
- `createScriptRun` (journaled, with idempotencyKey and sourceTaskId) is called only from `src/http/script-runs.ts:492`, among non-test code.
- `swarm-script` workflow steps (`swarm-script.ts:132-154`) and `run-saved.ts:49` call `runScriptWithRunCredential`. Neither calls `recordInlineScriptRun` or `createScriptRun` in the code I read. The workflow step passes only `{sourceStepId: meta.stepId}` (no `sourceScriptRunId`), and `run-saved.ts` passes no provenance.
- Whether `src/http/script-runs.ts:492` creates a `kind: "workflow"` row was not verified.

#### Recursion and depth limits

No depth limit exists for nested `ctx.swarm.script_run`. I found no depth check in `scripts.ts`, `run-credential.ts` or `swarm-sdk.ts`. The `parentScriptRunId` column has only a partial index (`293_...sql:30-31`).

Limits that do exist, elsewhere:
- Sub-workflow nesting: `MAX_SUB_WORKFLOW_DEPTH = 16` (`src/workflows/executors/sub-workflow.ts:33-34`). It is checked via `getWorkflowRunLineage` (`:105-111`). It also fails on a cycle, when the target workflow id is in the lineage (`:112-115`).
- Workflow run tree walks: `WORKFLOW_RUN_TREE_MAX_DEPTH = 32` (`src/be/db/workflow-runs.ts:184`). `getWorkflowRunTreeIds` throws past `maxDepth` (`:262-297`).
- Task lineage read bounds: `TASK_LINEAGE_LIMITS = {maxNodes: 500, maxDepth: 30, maxAncestors: 50}` (`src/be/db/tasks/read.ts:519`). `READABLE_WALK_MAX_DEPTH = 64` (`:946`). These bound reads only.
- Telemetry chain walk: `MAX_CHAIN_DEPTH = 50` (`src/telemetry-trigger.ts:20`).
- Pi codemode: `PI_CODEMODE_MAX_NESTED_CALLS = 32` (`src/providers/pi-mono-adapter.ts:1874`).
- A comment in `src/tests/human-free-reclassify.test.ts:425` states "Task creation has no depth limit".

```ts
export const MAX_SUB_WORKFLOW_DEPTH = 16;
```

#### Forged-provenance test (`src/tests/scripts-http.test.ts:701-755`)

The test is defined with `skip(...)`. `skip` is `test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)` (`:22`), so it is conditionally skipped.

It sends `X-Source-Step-Id` and `X-Source-Script-Run-Id` headers, plus body fields `sourceStepId`, `parentScriptRunId` and `sourceScriptRunId`, all set to forged values.
- **Token case:** it calls `POST /api/scripts/run` with a token minted by `mintScriptRunToken(workerId, 60_000, {sourceStepId: "step-from-token", sourceScriptRunId: "run-from-token"})`. The saved row has `sourceStepId: "step-from-token"` and `parentScriptRunId: "run-from-token"`, so the forged headers and body fields are ignored.
- **Operator-key case:** the operator key with an `X-Agent-ID` header and the same forged fields. Both columns are null.

```ts
expect(await row("plain-provenance")).toEqual({
  sourceStepId: null,
  parentScriptRunId: null,
});
```

#### Gaps

- I did not read `src/http/script-runs.ts` around line 492, so I could not confirm which `kind` it writes, whether `"workflow"` rows originate there, or how it executes.
- I did not trace `insertSessionToken` (`users.ts:782`) or how the `scriptRun` flag is used in `AGENT_TOKEN_BINDING`.
- I did not trace where `beginRequestAuthScope` and `setRequestAuth` are called in the HTTP pipeline, or how the agent auth is built from `resolveSessionToken`.
- I did not confirm whether workflow-step and `run-saved` runs get any `script_runs` row. A grep for `kind: "workflow"` in `db.ts`, `be/scripts/*.ts` and `workflows/**` found none.
- I did not check `x.ts`, `scheduler.ts` and `user-code-mode.ts` for how they pass provenance. The scheduler and x paths use `recordInlineScriptRun`, which stamps provenance only if the request has an agent token with provenance.
- I did not inspect the sandbox-spawn skip flag, so I don't know when the provenance test is skipped in CI.
### 6. The five script call sites

#### Overview

Five call sites invoke a saved script. Four call `runScriptWithRunCredential` (`src/be/scripts/run-credential.ts`) directly or through `runSavedScriptAsAgent` (`src/be/scripts/run-saved.ts:20`). The script is addressed by name (MCP, HTTP run, schedule, workflow node) or by uuid (app action, endpoint row). Args are always a separate JSON value.

#### 1. script_run MCP tool and POST /api/scripts/run

- The MCP tool `script-run` (`src/tools/script-run.ts:50-83`) takes `name?`, `source?`, `args?` (unknown), `intent`, `scope?` ("agent"|"global"), `fsMode` (default "none"), `executor?` (nullable), and `idempotencyKey?`. It has no `timeoutMs`. It proxies to `/api/scripts/run` (`:87-90`).
- The HTTP `runBodySchema` (`src/http/scripts.ts:77-90`) has the same fields and refines that exactly one of `name` or `source` is present.

```ts
.refine((body) => Boolean(body.name) !== Boolean(body.source), {
  message: "Provide exactly one of name or source",
```

- Auth: `auth: { userNamesAgent }` (`:266`). The route has no `rbac` field. The handler calls `requireAgent(res, agentId)` (`:757`) and does not call `can()`.
- Name resolution (`resolveScript`, `:606-617`): `scope` "global" or "agent" picks one scope. With no scope, it tries the agent scope (`scopeId` = caller) first, then global. A named run takes `source`, `fsMode` and the default executor from the stored row (`:783-793`).
- Rejections: `workspace-rw` returns 501 (`:795`). A native executor under a quickjs-only deployment returns 400 (`:800`).
- Execution: `runScriptWithRunCredential({source, args: parsed.body.args, fsMode, executor, agentId: agent.id, ...}, {sourceScriptRunId: runId, sourceStepId})` (`:820-840`). The row is recorded with `recordInlineScriptRun` (`:915`) with `scriptName: parsed.body.name ?? "(inline source)"`.
- Related user-MCP path: `script-run` in `src/server-user.ts:274` declares `rbac: permission("script.run")`, which is `anyAuthenticated` (`src/rbac/legacy-policy.ts:363`). It calls `runScriptForUser` (`:285`), which I did not trace.

#### 2. Schedules

- Migration 103 adds `targetType` (CHECK in `agent-task|workflow|script`), `workflowId`, `scriptName TEXT`, and `scriptArgs TEXT DEFAULT '{}'` (`src/be/migrations/103_schedule_target_type.sql:35-39`). A CHECK requires `scriptName IS NOT NULL` for script targets (`:51`).
- One-time vs cron is separate: `scheduleType IN ('recurring','one_time')`. Recurring needs `cronExpression` or `intervalMs` (`:44-47`). Migration 141 later added automation preflight JSON columns (`141_scheduled_task_automation_preflight.sql:2`).
- Tool input (`src/tools/schedules/create-schedule.ts:47-93`) has `targetType`, `scriptName` ("Catalog script name (global scope)"), `scriptArgs` (record), `delayMs`, `runAt`, `cronExpression` and `intervalMs`.
- HTTP `POST /api/schedules` (`src/http/schedules.ts:113-142`) has the same fields. It validates that `scriptName` exists in global scope (`:408-416`). The tool does the same (`create-schedule.ts:290-294`). Both create the schedule with `createdByAgentId`, and `scriptArgs` is stored as given (`schedules.ts:489-490`).
- The route declares no `rbac` field in the part I read. Updates restrict script fields to the creator or a lead (`:638`).
- Dispatch: `case "script": await executeScheduleScript(schedule)` (`src/scheduler/scheduler.ts:274-276`).

```ts
const script = await getScript({ name: schedule.scriptName, scope: "global" });
const agentId = schedule.createdByAgentId ?? "schedule";
const args = schedule.scriptArgs ?? {};
```

- `executeScheduleScript` (`:82-126`) calls `runScriptWithRunCredential` with `fsMode: "none"`, `timeoutMs: 60_000` and `{ sourceScriptRunId }`. Its `script_runs` row stores a comment pointer instead of the source (`:103`). Before dispatch, `renderScheduledTaskParams` renders params into the schedule snapshot (`:240`).

#### 3. Workflow swarm-script node

- Config schema (`src/workflows/executors/swarm-script.ts:29-41`): `scriptName`, `scope?`, `pinHash?`, `args` (record, default `{}`), `fsMode` (default "none"), and `timeoutMs` (bounded, default `DEFAULT_SCRIPT_RESOURCES.wallClockMs`).

```ts
scriptName: z.string().min(1),
scope: z.enum(["global", "agent"]).optional(),
pinHash: z.string().min(1).optional(),
args: z.record(z.string(), z.unknown()).default({}),
```

- The engine interpolates node config before the executor runs (`src/workflows/engine.ts:1081-1088`, `interpolateNodeConfig`). `args` values therefore arrive already interpolated from `{{...}}` tokens.
- The executor resolves the principal as `workflow.createdByAgentId ?? getWorkflowRunTriggeredByAgentId(runId)` (`:99-102`). It never reads `trigger.agentId`.
- `resolveScriptSource` (`:200-264`): with `scope` "agent" it requires an agent id. With no scope it tries the agent scope, then global, and global only when no agent id exists. `pinHash` loads `getScriptVersion({scriptId, contentHash})` and uses that version's source.
- The script body is rejected if it contains workflow interpolation tokens (`:112-121`).
- Execution: `runScriptWithRunCredential({source, args: config.args, agentId: agentId ?? "workflow", timeoutMs, signal: meta.signal ...}, { sourceStepId: meta.stepId })` (`:132-154`). `workspace-rw` fails (`:85`).
- The inline `script` node (`src/workflows/executors/script.ts:98-101`) is separate. It takes `runtime` (bash, ts or python), a `script` string, and `args` as a string array. It runs a subprocess and does not use the saved-script loader.

#### 4. App action kind "script"

- Schema (`src/apps/definition.ts:350-353`):

```ts
kind: z.literal("script"),
scriptId: z.string().uuid(),
args: z.record(z.string(), z.unknown()).optional(),
```

- Write-time validation (`:1078-1113`) checks that the script exists. A writer may only wire a script it owns (`foreignScriptForWriter`), or a global script whose owner is that writer. Existing references are grandfathered.
- Invoke time (`src/apps/action-runner.ts:61-92`): `getScriptById(action.scriptId)` returns 400 if the script is missing. `getSavedScriptOwnerAgentId(script)` is `script.scopeId ?? script.createdByAgentId` (`run-saved.ts:11-13`). It returns 400 if there is no owner.

```ts
input: { ...action.args, ...input, app: { id: app.id }, caller },
agentId: runAsAgentId,
```

- Args are built as definition `args`, overridden by caller `input`, plus `app.id` and `caller`. Nothing is built from a row here. The input comes from the request body (`src/http/apps.ts:1495`).
- RBAC for the HTTP route is `app.use` through `authorizeAppUse` (`apps.ts:263`, `:1512`). The runner is `runSavedScriptAsAgent` (`run-saved.ts:20-77`), which calls `runScriptWithRunCredential` with the script's own `fsMode` and `executor` (`:49-63`).

#### 5. Per-script HTTP endpoints

- `script_apis` (`src/be/migrations/102_script_apis.sql:11-24`): `id` (12 random letters, public), `scriptId` (FK, ON DELETE CASCADE), `agentId` (run-as), `authMode` ('none'|'bearer'), `bearerTokenEncrypted`, `enabled`, `label`, `callCount`, `lastUsedAt` and audit columns. Migration 102 also adds `script_runs.apiEndpointId` (`:31`).

```sql
authMode TEXT NOT NULL CHECK(authMode IN ('none', 'bearer')),
bearerTokenEncrypted TEXT,
```

- CRUD routes in `src/http/scripts.ts`:

| Route | Permission |
|---|---|
| POST `/api/scripts/{id}/apis` (`:435`) | `script.api.create` |
| GET `/api/scripts/{id}/apis` (`:461`) | no `rbac` field |
| GET `.../apis/{endpointId}/secret` (`:478`) | `script.api.read.secrets` |
| PATCH `.../apis/{endpointId}` (`:496`) | `script.api.update` |
| POST `.../rotate` (`:522`) | `script.api.rotate` |
| DELETE `.../apis/{endpointId}` (`:541`) | `script.api.delete` |

- Create body: `authMode` (default "bearer"), `label?`, `agentId?`. The run-as agent is `body.agentId ?? script.scopeId ?? script.createdByAgentId`, and 400 if none (`:1147-1151`).
- Public route: `handleX` in `src/http/x.ts:160`, `POST /api/x/script/{endpointId}` (`:72-105`, `auth: { apiKey: false }`).
- Flow: `getScriptApiById`, then 404 if the endpoint is missing or disabled (`:168-173`). In bearer mode it compares the bearer with `getScriptApiSecret` using `timingSafeEqual` (`:175-186`). Then there is a 1 MB body cap (`:188`).
- The whole parsed JSON body is the args (`args = await parseBody(req)`, `:190-193`). `script.argsJsonSchema`, when present, is validated host-side (`:219-236`).
- The script is loaded by `getScriptById(endpoint.scriptId)`. `workspace-rw` returns 501 (`:209`).
- Execution: `runScriptWithRunCredential({source: script.source, args: args ?? null, [HOST_VALIDATED_ARGS], executor: script.executor, agentId: endpoint.agentId, timeoutMs ...})` (`:248-267`). `timeoutMs` comes from the `X-Swarm-Timeout-Ms` header, default 60000, clamped (`:122-129`).
- Response is always HTTP 200 once execution is reached: `{ok, result, error, durationMs}` (`:305-309`). stdout and stderr are not exposed. Failures use `error.type` values such as `runtime_error`, `timeout` or `args_validation`.

#### Gaps

- I did not read `runScriptForUser` (the user-MCP run path) or `runScriptWithRunCredential`'s body past `:70`.
- I did not confirm whether `POST /api/schedules` has an RBAC gate beyond the creator rule at `schedules.ts:638`. I saw no `rbac` field on the route.
- I did not read `interpolateNodeConfig` itself, only its call site.
- The `heartbeat.ts`, `ui-spec/script-actions.ts`, `follow-up-gate.ts` and `apps/sync.ts` callers of `runSavedScriptAsAgent` are outside the five requested sites. I did not read them.
- Scheduler one-time behavior after a fire (disable or delete) is not covered.

### 7. Extensions and scripts, KV, state

#### What an extension is: manifest and entry code

The manifest is `ExtensionManifestSchema` (`src/types.ts:4087-4115`). It is a strict object: `name`, `description`, `version`, `runtime: "api" | "worker"`, `assets.hooks`, optional `scripts`/`schedules`/`workflows`/`skills`, and `toolSources`.
```ts
runtime: z.enum(["api", "worker"]),
assets: z.object({ hooks: ExtensionBundlePathSchema, scripts: ..., schedules: ..., workflows: ..., skills: ... })
```
`superRefine` (`src/types.ts:4116-4149`) requires every script and schedule name to start with `<name>-`. A schedule's `script` must be declared in `assets.scripts`.

The entry code is one hooks file. It must default-export a function that takes an `api` object (`HooksModule`, `src/extensions/contract.ts:62-65`). It may also export a Zod `config` schema. The worker runtime is rejected at install (`runbooks/extensions.md:80`). Worker hooks do not run (`runbooks/extensions.md:413`).

#### How the code runs

The code runs in the API server process. It is not a saved script and not a sandboxed subprocess. It is also not a separate long-lived process (`runbooks/extensions.md:5`, `:12-15`).
`loadExtension` (`src/extensions/loader.ts:123-208`) writes the bundle to `${tmpdir()}/swarm-extensions/<pid>/<name>/<contentHash>` (`loader.ts:13-14`, `:125`). It writes bare-import shims for `stdlib`, `zod` and `swarm-extension` (`loader.ts:54-83`), then `await import(sourcePath)` (`loader.ts:152`).
```ts
mod.default(api);
```
Calling the default function at load time (`loader.ts:184`) only registers handlers through `api.on` (`loader.ts:175-183`). The module therefore lives from enable or reload until disable, uninstall or auto-disable. Bun cannot unload it (`loader.ts:198-199`).
Each event invocation is a fresh call of the registered handler with a freshly built `ctx` (`dispatcher.ts:319-324`). Module-level variables persist in the API process between events. Nothing in the loader or dispatcher manages them.

Bundled `assets.scripts` are ordinary global scripts owned by the `ext:<name>` agent. They are live from install and callable through `script-run` without any extension-state check (`runbooks/extensions.md:181-184`). Schedules can target only a script (`:419`).

#### How extension code calls the swarm

`buildCtx` (`src/extensions/ctx.ts:122-186`) returns `swarm`, `state`, `config`, `log`, `signal` and `event`. `ctx.swarm` is a Proxy over `createSwarmSdk(new SwarmConfig(...))` (`ctx.ts:146-156`, `:159-173`). The SDK runs against the loopback base URL with the `ext:<name>` agent id and a bridge token (`extensionToken`).
```ts
agentId: { value: loaded.record.agentId, isSecret: false },
mcpBaseUrl: { value: getExtensionLoopbackBaseUrl(), isSecret: false },
extensionToken: { value: getExtensionBridgeToken(), isSecret: true },
```
The server grants `callOrigin: "extension"` only when the agent id is a registered extension agent and the request carries the per-process token (`dispatcher.ts:64-76`; `src/http/mcp-bridge.ts:180`). Extension-origin calls bypass `pre.tool.call` and `post.tool.call` (`runbooks/extensions.md:345-347`).
`script_run` is on the SDK allowlist (`src/scripts-runtime/sdk-allowlist.ts:76`, mapped to `script-run`). Nothing in `src/extensions/*.ts` special-cases or blocks it. Hooks are not themselves scripts, so no `ctx.fs` or `ctx.sh` is documented for them.

#### State and KV usage

`ctx.state` offers `get`, `set`, `incr` and `del` (`contract.ts:67-72`). Each call goes through the in-process MCP tools `kv_get`, `kv_set`, `kv_incr` and `kv_delete`. The key is prefixed `ext:<name>:` (`ctx.ts:40-42`, `:44-74`).
```ts
function prefixedStateKey(loaded, key) { return `ext:${loaded.record.name}:${key}`; }
```
`ctx.state` passes no namespace argument. Examples:
- `templates/extensions/task-digest/hooks.ts:15,18` uses `ctx.state.incr`.
- `templates/extensions/deploy-awareness/hooks.ts:116,126` uses `ctx.state.set` and `ctx.state.get` for a cached snapshot.
- `templates/extensions/comms-adherence-gate/hooks.ts:68` bypasses `ctx.state`. It declares `const NS = "ext:comms-gate"` and calls `ctx.swarm.kv_incr/kv_set/kv_get({ namespace: NS, key })` (`:703-737`).

Values are JSON via the KV tools. The `ctx` surface exposes no database client (`runbooks/extensions.md:366-367`).

#### pre/post events and dispatch

Events are keyed in `SwarmEventMap` (`contract.ts:451-500`). Pre events are `pre.task.create`, `pre.task.followUp`, `pre.task.steer`, `pre.slack.route`, `pre.chat.route`, `pre.heartbeat.remediate` and `pre.tool.call`. Post events cover tasks, slack, chat, approval, budget, email, kapso, vcs and tool calls.
```ts
"post.task.completed": { event: TaskCompletedEvent; modify: never; result: void };
```
`dispatchPre` (`dispatcher.ts:401-511`) returns `continue` and logs when `isInTransaction()` is true (`:406-409`). Otherwise it runs handlers sequentially with `await`, sorted by priority then extension name (`:100-117`, `:414-416`). Each valid `modify` becomes the next handler's payload (`:482-483`). The first `block` stops the chain (`:446-462`). `dispatchPost` (`:515-535`) also runs handlers one after another. It has no transaction guard, because bus events emit after commit (`:513-514`).

Each handler is raced against a timeout of 5000 ms by default, set by `EXTENSION_HANDLER_TIMEOUT_MS`, with an `AbortController` (`:299-333`). Failures fail open. After `EXTENSION_MAX_CONSECUTIVE_FAILURES` (default 5) consecutive failures the extension is auto-disabled (`:260-297`).

Serialization applies only within one dispatch call. I found no per-extension, per-key or per-entity mutex or queue. Separate dispatch calls are not coordinated with each other in the code I read.

Between events an extension keeps state in `ctx.state` / KV, in the `config` loaded at load time (`loader.ts:160-172`), or in module scope (`loader.ts:152`).

#### Generated typed surface

`bun run build:extension-types` runs `scripts/bundle-extension-types.ts` (`package.json:96`). The script compiles `src/extensions/contract.ts` with the TypeScript compiler API (`bundle-extension-types.ts:44-52`). It emits the declaration and inlines `CreateTaskOptions`, `AgentTask`, `ActiveSession`, `SteerMode`, `SteeringSource` and `RequestInfo` (`:68-80`).
```ts
const OUTPUT_FILE = "src/scripts-runtime/types/swarm-extension.d.ts";
const CONSTANT_FILE = "src/extensions/contract-types.generated.ts";
```
It wraps the declaration as `declare module "swarm-extension"` in `swarm-extension.d.ts` (`:87-92`). It then writes the same text as `EXTENSION_TYPE_DEFINITIONS` into `contract-types.generated.ts` (`:93-98`). Install typechecks the hooks file against that `.d.ts` (`runbooks/extensions.md:83`). At runtime the `swarm-extension` import resolves to `contract-runtime.ts`, or to `extensions-contract.bundle.js` under `SCRIPT_RUNTIME_DIR` (`loader.ts:54-83`).
The catalog is embedded as `src/extensions/catalog.generated.json`. The generator is `bun run build:extension-catalog`, and it never reads `templates/` at runtime (`runbooks/extensions.md:143`, `:153-158`).

#### Gaps

- I did not read `src/extensions/lifecycle.ts`, `post-bridge.ts`, `src/be/extensions/*` or `src/http/extensions.ts` in detail. The lead-equivalence behaviour is taken from the runbook (`runbooks/extensions.md:239`).
- I found no extension-specific code that serializes per extension, per entity or per key. I did not check KV-level atomicity beyond `kv_incr`.
- I did not confirm whether `script_run` through `ctx.swarm` is restricted by RBAC for the `ext:<name>` agent. The extension code does not block it.
- I did not verify the KV default namespace that `kv_get`/`kv_set` use when no `namespace` is passed.
- No example in `templates/extensions` calls `script_run`.

### 8. Pages, their state and how they call the swarm

#### What a page is, authoring, storage

A page is a DB row holding agent-authored HTML or a json-render spec. Authoring goes through the `create_page` MCP tool, which is gated on the `pages` capability (`templates/skills/pages/content.md:11-14`). `POST /api/pages` and `PUT /api/pages/:id` also write pages (`content.md:380`).

The `pages` table has `agentId`, `slug`, `contentType`, `authMode`, `passwordHash` and `body`, with `UNIQUE (agentId, slug)` (`src/be/migrations/059_pages.sql:17-31`). Later migrations rebuild the table (`086_pages_default_authed.sql`, `148_pages_svg.sql`). The code also serves `image/svg+xml` pages (`src/http/pages-public.ts:665`). Each overwrite snapshots the old state into `page_versions` (`content.md:658-661`). The body cap is 5 MiB per version (`content.md:1020`).

```sql
contentType  TEXT NOT NULL CHECK (contentType IN ('text/html','application/json')),
authMode     TEXT NOT NULL DEFAULT 'public' CHECK (authMode IN ('public','authed','password')),
```

#### Serving and who can view

`GET /p/:id` is handled in `src/http/pages-public.ts`. Per `authMode`:
- `public` has no gate (`pages-public.ts:452`).
- `authed` needs the `page_session_<id>` cookie, minted by `POST /api/pages/:id/launch`, or a signed-in SPA viewer (`pages-public.ts:458`, `content.md:629`).
- `password` takes `?key=` or HTTP Basic on `/p/:id`. It mints a guest session (`content.md:630`).

HTML is served inline with an injected head: design system, `BROWSER_SDK_JS` and `SWARM_UI_JS`. JSON pages return a 302 to `${APP_URL}/pages/:id` (`pages-public.ts:701-706`). `/p/:id.json` returns metadata plus the raw body (`pages-public.ts:651-659`). The CSP includes `connect-src 'self'` (`content.md:90`).

```ts
Location: `${getAppBaseUrl()}/pages/${page.id}`,
```

#### Dashboard rendering

The SPA route is `apps/ui/src/pages/pages/[id]/page.tsx`. HTML renders in an iframe with `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"` (`page.tsx:270`). JSON pages render through `@json-render/react` in `json-page-renderer.tsx`. That renderer registers two custom actions, `swarm.sdk` and `swarm.call` (`json-page-renderer.tsx:10-13`). It uses the viewer's bearer and does not go through the `/@swarm/api` proxy (`json-page-renderer.tsx:17-19`). `swarm.call` is described in `src/http/pages.ts:694`.

```tsx
sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
```

#### Page state: KV namespace

`pageContextKey({pageId})` returns `task:page:<id>` (`src/tasks/context-key.ts:315`, doc at line 33). The SDK exposes `kv.get/set/del/incr/list` with no namespace argument (`src/pages/browser-sdk.ts:135-145`). The proxy sets `X-Page-Id`, and the KV handler gives that header highest priority (`src/http/page-proxy.ts:288-295`; `src/http/kv.ts:307`, `482`). A write to `task:page:*` without that header returns 403 (`src/http/kv.ts:382-384`). The MCP KV path rejects it too (`src/tools/kv/kv-write-auth.ts:35-36`). Deleting a page deletes its namespace rows (`src/be/db.ts:8999`).

```ts
"X-Page-Id": page.id,
"X-Page-Session": session.token,
```

#### Browser to backend: SDK, proxy, auth

`window.SwarmSDK` and `window.swarmSdk` are injected (`browser-sdk.ts:152-153`). Every call is `fetch('/@swarm/api' + path)` with `X-Swarm-Page-Id` (`browser-sdk.ts:32-44`).
- Domains: tasks, agents, events, memory, repos, schedules, approvalRequests, assets, kv (`browser-sdk.ts:70-145`).
- `handlePageProxy` validates the page cookie (`page-proxy.ts:246-256`) and loads the page (`page-proxy.ts:259`). It rewrites `/@swarm/api/x` to `/api/x` and forwards in-process to `127.0.0.1:$PORT` with `Authorization: Bearer ${getApiKey()}` (`page-proxy.ts:282-296`).
- Path handling is a traversal guard only, not a route allowlist (`page-proxy.ts:172-178`, `236-237`).
- A guest session (no `uid`, no `op`) may only call `kv*` and `GET pages/<own id>` (`page-proxy.ts:207-213`, `268-271`).
- User-token launches keep the viewer identity. Operator launches keep deployment-level access (`content.md:998-1000`).
- Public pages mint no cookie, so SDK calls return 401 (`content.md:719-721`).

```ts
const res = await fetch(base + path, init);
```

#### Scripts and apps from a page

- The SDK has no `scripts`, `apps` or `x` domain (`browser-sdk.ts:70-145`).
- Because the proxy forwards any `/api/*` suffix for non-guest sessions, a direct `fetch('/@swarm/api/...')` works with the viewer's authorization (`page-proxy.ts:236-237`; `content.md:678-680`). I did not trace which script or app routes this reaches.
- `POST /api/x/script/{endpointId}` is declared `auth: { apiKey: false }` and returns `{ ok, result, error, durationMs }` (`src/http/x.ts:72-85`, `56-70`). Its CORS is permissive by default (`x.ts:36-44`), but the page CSP `connect-src 'self'` blocks cross-origin fetch (`content.md:90`).
- `swarm.call` in JSON pages is a raw HTTP action, so it can target any swarm API path (`content.md:986-991`).
- Agents, scripts and workflows can reach page rooms through `ctx.swarm.room.get/change/decode` (`content.md:1162-1173`).

#### Typed client for page code

None found. The injected SDK is plain JS in a template string (`browser-sdk.ts:24`). The "Full signature" block in the skill is documentation only (`content.md:725-729`). It lists no `kv`, `room` or `channel`, although the SDK has them.

#### Realtime

Rooms use Yjs over WebSocket. `swarmSdk.room()` and `swarmSdk.channel()` lazy-import `/@swarm/realtime.js` (`browser-sdk.ts:27-30`), served by `src/http/realtime.ts:33`, `87`.
- The browser client opens `/@swarm/realtime?pageId=<id>` and extracts the id from `/p/<id>` (`src/realtime/browser.ts:74-80`).
- The server transport is `ws` `WebSocketServer` on `/@swarm/realtime` or `/api/realtime` (`src/realtime/transport.ts:189-198`).
- If a page id is present, the namespace is forced to `task:page:<id>` (`src/realtime/auth.ts:59-62`).
- Snapshots persist under `_room/<name>` in that namespace and flush within about 1 second (`content.md:1146-1147`). The limits are 2 MiB per snapshot and 100 rooms per namespace (`content.md:1151-1152`).
- Room changes emit a `room.changed` workflow event (`content.md:1176`). Deleting a page publishes `room:namespace-deleted` (`db.ts:9004`).
- Channels are transient publish and subscribe with no persistence (`content.md:1181-1183`).
- I found no `EventSource` or `setInterval` in `src/realtime/**`, `src/http/page*` or `src/pages/**`.

```ts
const url = new URL("/@swarm/realtime", location.href);
url.searchParams.set("pageId", decodeURIComponent(match[1]!));
```

#### Gaps

- I did not read `src/http/pages.ts` in full. This covers CRUD, the `launch` handler, RBAC verbs and the ownership 403.
- I did not read `src/http/kv.ts` beyond the namespace resolution lines.
- I did not trace whether `/api/scripts*`, `/api/apps*` or `script_run` are reachable through the proxy. Authorization for those routes would come from the forwarded bearer and `X-Page-Session`.
- I did not read the page-session cookie signing and payload in `src/utils/page-session.ts`.
- I did not read `json-page-renderer.tsx` beyond its header. That includes the exact `swarm.sdk` dispatch.
- I did not open `src/realtime/rooms.ts`, `transport.ts` or `browser.generated.txt`.
- UI polling inside the `/pages` SPA (react-query's 5s default, per `apps/ui/CLAUDE.md`) was not confirmed for pages specifically.

### 9. Apps and typed script access

#### Apps types for scripts: `getScriptAppTypes`
- `getScriptAppTypes` ignores its context argument (`_context`, reserved for a future `app.use` filter) and returns `renderAppTypes(await listAppRecords())`. It returns `""` on any error (`src/apps/script-types.ts:292-302`). Apps with a `definitionError` are skipped with a comment (`:256`, `:230-241`). Output is capped at `MAX_APP_TYPES_BYTES = 32 * 1024` (`:5`), and overflow apps become an "omitted" trailer (`:243-252`).
- Each app becomes `export namespace App_<PascalName>` (`:206-207`). It holds one interface per model, with the 5 system columns plus declared non-hidden columns (`:96-104`). Required columns are non-optional, enums become literal unions, `json` becomes `unknown` (`:71-75`). It also holds `ActionName` and `ActionArgs` (`:211-217`).
- Each named query adds an `app_query` overload to `SwarmSdk`. Filter `$param`s become typed `params` (`:153-183`). A param reused across columns gets the intersection of the column types (`:125-145`).

```ts
  app_query(args: {
    appId: ${JSON.stringify(app.id)};
    query: ${JSON.stringify(queryName)};
    ${paramsType}
  }): Promise<SwarmAppQueryResult<${namespace}.${modelInterfaceName}>>;
```
- Actions are typed only as a name union. The generated comment says "Declared actions are callable through REST or MCP only" (`:210`). No `ctx` method runs an action.

#### Type contributor wiring
- `ScriptTypeContributor = (context) => string | Promise<string>`. The doc comment names three implementations: `getScriptApiTypes`, `getScriptMcpTypes` and `getScriptAppTypes` (`src/be/scripts/type-contributors.ts:12-24`). `ScriptTypeContext` is `{ agentId?, repoId? }` (`:6-9`).
- `typecheckScript` calls the three and passes them to `scriptSdkTypesWithGeneratedApis(apiTypes, mcpTypes, appTypes)`. It calls `scriptStdlibTypesWithGeneratedApis` only when `appTypes` is non-empty (`src/be/scripts/typecheck.ts:1590-1611`). The ambient modules are `swarm-sdk` and `stdlib`.
- The user script is checked as `ScriptMain` (`typecheck.ts:1604-1609`).

#### Connection types: `getScriptApiTypes` / `getScriptMcpTypes`
- Both read `listScriptConnections(context)` (the API one filters kinds `openapi`, `graphql`, `sql`; the MCP one filters `kind: "mcp"`). They concatenate each connection's stored `generatedTypes` and append a registry interface keyed by slug (`src/be/script-connections.ts:2186-2210`). With no blocks they return `export interface ScriptApiRegistry {}` or `ScriptMcpRegistry`.
- The generator emits two overloads per operation, typed and raw (`:995-1003`):

```ts
`  ${operation.name}(args: ${operation.requestType}): Promise<${operation.responseType}>;`,
`  ${operation.name}(args: ${operation.requestType}, options: ScriptApiRawOptions): Promise<ScriptApiRawResult>;`,
```
- `ScriptContext` exposes these as `api: ScriptApiRegistry` and `mcp: ScriptMcpRegistry` (`typecheck.ts:903-904`).

#### Runtime routing: `ctx.*`
- `ctx.swarm` is typed `SwarmSdk & { config }` (`typecheck.ts:902`). Apps have no ctx namespace. They reach scripts as flat SDK methods mapped to MCP tools in `SDK_TOOL_NAME_MAP`: `app_query: "app-query"`, `app_rows_list`, `app_row_create`, `app_row_patch`, `app_sync`, `app_upsert` and others (`src/scripts-runtime/sdk-allowlist.ts:204-219`). There is no `app_action_run` entry in that range.
- `SDK_NAMESPACES` currently holds only `objects`, `sheets` and `boards` (`sdk-allowlist.ts:273-288`). `ctx.<ns>.<m>` calls `<ns>_<m>` (`:306-308`). A new entry needs map entries, a typed `ScriptContext` key (`:267-271`), and a non-reserved name (`RESERVED_CTX_KEYS`, `:291-302`).
- `createNamespaceClients(swarmConfig, { registry })` is wired in `src/scripts-runtime/ctx.ts:58`. `ctx.ts:33,43,51` also covers script-workflow and QuickJS (`guest-ctx.ts:3`, `quickjs-runner.ts:12`).

#### App state and UI access
- Rows live in the KV store under namespace `apps:<appId>`. Row keys are `<model>/row/<rowId>` and index keys are `<model>/idx/<column>/<value>/<rowId>` (`src/apps/row-store.ts:74-96`).

```ts
export function appsNamespace(appId: string): string {
  return `apps:${appId}`;
}
```
- Writes are serialized by `withMutationLock` (`row-store.ts:216`). Indexes cover enum columns and opted-in string/boolean columns (`:98-103`).
- Row CRUD is in `row-store.ts` (`createAppRow`, `listAppRows`, `patchAppRow`, `deleteAppRow`, and others at `:292-606`).
- The dashboard uses HTTP routes: row CRUD at `/api/apps/{id}/models/{model}/rows[...]` (`src/http/apps.ts:475-565`), a named-query route (`:585`), and `POST /api/apps/{id}/actions/{name}` (`:630`).
- The design doc says rows live in KV and the API server owns CRUD and indexes (`thoughts/taras/design-docs/swarm-apps.md:96`, I11 at `:49`).

#### Action runner
- `runAppAction` looks up `app.definition.actions[name]` and returns 404 if it is missing (`src/apps/action-runner.ts:54-57`). It has three kinds.
  - `script` loads `getScriptById(action.scriptId)` and runs it as the owning agent via `runSavedScriptAsAgent`. The input is `{ ...action.args, ...input, app: { id }, caller }` (`:61-92`).
  - `sync` runs `runAppSync` (`:111-136`).
  - `task` creates a task from the `task.app.action` template (`:138-165`).

```ts
input: { ...action.args, ...input, app: { id: app.id }, caller },
agentId: runAsAgentId,
```

#### Typed bindings between saved scripts
- Each saved script stores `signatureJson`. The `ScriptSignature` type is `{ argsType, resultType, description }`, strings extracted from the default-export function's first param and return type (`src/scripts-runtime/extract-signature.ts:3-7,31-41`). Producers include `src/http/scripts.ts:602-603` and `src/be/seed-scripts/index.ts:471`.
- Consumers of `signatureJson` are the HTTP script responses (`src/http/scripts.ts:1028,1060`), `src/be/scripts/user-code-mode.ts:27`, and embedding text (`src/be/scripts/embeddings.ts:58`).
- The SDK has `script_run(args: { name?, source?, args?, ... }): Promise<unknown>` (`typecheck.ts:480`). Its result is `unknown`.

```ts
export type ScriptSignature = {
  argsType: string;
  resultType: string;
  description: string;
};
```

#### Gaps
- I found no type contributor or generator that turns one saved script's `signatureJson` into typed args and result for another script. `script_run` returns `unknown` (`typecheck.ts:480`), and a grep of `typecheck.ts` shows no signature-derived typing.
- Apps have no `ctx.apps` namespace. Action invocation from scripts has no SDK method and no generated type beyond the `ActionName` union.
- `getScriptAppTypes` is not filtered by agent or `app.use` (`script-types.ts:292-296`).
- I did not read `createNamespaceClients` in `swarm-sdk.ts` or the bridge (`bridgeRequestFor`). The runtime hop from `ctx.swarm.app_query` to the HTTP or MCP route is therefore not traced.
- I did not trace how the dashboard's json-render state maps to the row routes. I only confirmed the routes exist.
- The `swarm-sdk.d.ts` and `stdlib.d.ts` copies under `src/scripts-runtime/types/` also contain `app_query`, but I did not check how they relate to the per-call contributor output.

### 10. Realtime, streaming and WebSocket infrastructure

#### Transports present

The API server is a `node:http` server, not `Bun.serve`. Two WebSocket endpoints and the MCP streamable HTTP endpoints are attached to it. The grep found no hand-written `text/event-stream` response writer in non-test server code.

- `src/http/index.ts:289` creates it: `const httpServer = createHttpServer(async (req, res) => {`
- `src/http/index.ts:496-498` attaches both WebSocket transports to that server.
- Both use `ws` with `noServer: true` and `server.on("upgrade", ...)` (`src/realtime/transport.ts:189,221`; `src/http/controllers-connect.ts:56,73`).

```ts
const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
...
server.on("upgrade", onUpgrade);
```

#### Realtime WebSocket (`src/realtime/transport.ts`)

- It upgrades only `/@swarm/realtime` and `/api/realtime` (`:198`). Any other path is destroyed, except `/api/controllers/connect`, which it skips (`:195`).
- It caps `wss.clients.size + pendingUpgrades` at 1000 (`:199`).
- One socket multiplexes rooms and channels. The zod `messageSchema` (`:45-69`) allows ops `join, leave, update, change, reset, presence, subscribe, unsubscribe, publish`, with an integer `id`.
- Server frames carry `seq` and the client replies `{ack: seq}` (`src/realtime/worker-client.ts:132`; `runbooks/realtime-rooms.md:73`).
- Limits (`runbooks/realtime-rooms.md:80-81`): 128 unacked frames, 8 MiB outstanding, 3 MiB incoming, channel data 64 KiB, presence data 8 KiB.
- A worker connects with a bearer token and `X-Agent-ID`, then subscribes to namespace `worker:<agentId>`, name `nudge` (`src/realtime/worker-client.ts:119-127`). It receives `{type:"channel", data}` frames parsed as `WorkerNudge`.

```ts
if (!origin || new URL(origin).host !== header(req, "host"))
  throw new Error("Invalid page origin");
```

#### Realtime auth and presence

- `authenticate` (`transport.ts:151-186`) checks in this order: a one-shot `?ticket=` (`redeemRealtimeTicket`), then `?pageId=` with an Origin and host match plus a page session cookie (public pages allow anonymous guests), then bearer auth via `resolveHttpRequestAuth`.
- Controller tokens are rejected (`:97,153`).
- Agent tokens must match the `X-Agent-ID` and `X-Runtime-Instance-ID` headers (`:98-105`). Token validity is rechecked through `sessionToken.check` (`:136-145`).
- Auth runs before the upgrade, and a failure writes `HTTP/1.1 401 Unauthorized` (`:204-206`).
- Dashboard tickets come from `POST /api/realtime/ticket` (`src/http/realtime.ts:12-16`). They have a 60 s TTL and a capacity of 10,000 (`src/realtime/tickets.ts:3-4`).
- Presence uses Yjs awareness, is never persisted, and is throttled to 50 ms in the browser (`runbooks/realtime-rooms.md:65`). The Comb presence namespace is `presence:comb:<orgId>:<driveId>` and accepts only `join`, `leave` and `presence` (`:99-106`).

```ts
export const REALTIME_TICKET_TTL_MS = 60_000;
```

#### Bus, rooms and channels

- `InProcessBus` wraps a Node `EventEmitter`, with synchronous publish and subscribe, and is held on `globalThis` (`src/realtime/bus.ts:5-33`).
- Rooms are Yjs documents persisted as a single KV envelope at `_room/<name>` (`runbooks/realtime-rooms.md:43-47`). They flush within about 1 s, with limits of 100 rooms per namespace and 1,000 active rooms per process (`:56-58`).
- Room changes publish on `roomTopic(...)` and `workflow:room.changed` (`src/realtime/rooms.ts:209,219`).
- Channel topics are `channel:${JSON.stringify([namespace, name])}` (`src/realtime/channels.ts:1-3`). Channels are transient and have no replay (`runbooks/realtime-rooms.md:18,87`).
- Scripts reach rooms through `ctx.swarm.room.get/change/reset/decode` and never load Yjs (`:17`).
- Rooms also have REST routes in `src/http/rooms.ts` (list `src/http/rooms.ts:37-114`) and MCP tools `room-get`, `room-change`, `room-reset` and `room-decode`.

```ts
export class InProcessBus {
  private readonly emitter = new EventEmitter();
```

#### Controller WebSocket

`GET /api/controllers/connect` requires a controller token and is gated by `isRuntimePoolsEnabled()`. It returns 404 when pools are off and 401 on auth failure (`src/http/controllers-connect.ts:27-40,58-71`). Its `maxPayload` is 1 MiB, and the client is `src/commands/controller.ts:60`.

```ts
description: "Requires a controller token and a WebSocket upgrade. Accepts one session per controller.",
```

#### SSE and streamed bodies

- `/mcp` and `/mcp-user` use the MCP SDK's `StreamableHTTPServerTransport` (`src/http/mcp.ts:195`; `src/http/mcp-user.ts:75`). SSE is produced inside the SDK, not in repo code. The session maps are `globalThis`-held (`src/http/index.ts:281-283`).
- `src/http/agentfs-proxy.ts` streams the upstream body to the client with `pump()` (`:340,345`). Its route is `unstructured: "Body is streamed from agent-fs; ..."` (`:78`). It can carry upstream SSE (tests use `Accept: text/event-stream`).
- `route-def.ts:16` documents `unstructured` as covering SSE streams. I found no repo route that uses it for a first-party event stream.

```ts
unstructured: "Body is streamed from agent-fs; shape and content-type vary per upstream route",
```

#### Script output streaming

- `POST /api/scripts/run` is request/response (`src/http/scripts.ts:262-283`). `scriptRunResponseSchema` returns `result`, `stdout`, `stderr`, `truncated`, `durationMs`, `exitCode` and `error` only once, at the end (`:167-181`).
- The sandbox caps stdout at 1 MB (CLAUDE.md scripts-runtime section).
- `ctx.logger` is typed as `interface ScriptLogger extends Console {}` (`src/scripts-runtime/types/swarm-sdk.d.ts:1124,1228`). I found no code that forwards it live to a client.
- Scripts can publish to a channel or room via `ctx.swarm.room`, as described above. This is the only live push path. I did not find a script-specific `ctx.channel` helper in `src/scripts-runtime`.
- Durable one-off script runs are launched by an MCP tool and inspected by polling. `get-script-run` returns status and journal entries for `swarm-script`, `raw-llm` and `agent-task` steps (`src/tools/script-runs.ts:8-14`). I found no stream or WebSocket for them.

```ts
"Launch a durable one-off script workflow run. The run executes in the background and can be inspected with get-script-run ..."
```

#### Single-replica assumptions

Documented only in `runbooks/realtime-rooms.md:89`, not in code comments. The grep for "single", "replica" and "process-local" in `src/realtime/*.ts` found nothing.

```
Run a single API replica. Sticky sessions do not provide shared state between replicas.
```

The same file says the bus is "shared process bus" (`:84`), and a crash can lose up to the last unflushed second of room state (`:52`). Channel subscriptions (`channels.ts:8`), tickets and live rooms are all process-memory.

#### Gaps

- I did not read `src/realtime/rooms.ts`, `auth.ts` or `document.ts` in full. Room auth details come from the runbook.
- I did not trace how `ctx.swarm.room` is wired into the script sandbox.
- I did not inspect `src/http/mcp-user.ts` beyond the transport construction.
- Whether `agentfs-proxy` forwards upstream SSE live is inferred from `pump()` and test usage.
- I did not check the workflow executors for step or journal event publishing on the bus.
- The `workflow:<event>` topic list was not enumerated.

### 11. Open questions: DB client, KV leases, schedules RBAC

#### 1. Single DbClient statements outside `transaction()`

A lone `run/get/query` is not wrapped in BEGIN. Each one is a single autocommit driver call, taken under a FIFO lock. It is retried on SQLITE_BUSY with backoff. `src/be/db-client.ts:681-685`:
```ts
// A top-level single statement is atomic, so a repeat on BUSY is
// exact. The final attempt spins `finalAttemptSpinMs` (see
// transaction()).
const db = this.getDatabase();
const result = timed(() => this.shortSpin(db, () => op(db), !canRetryAfter), canRetryAfter);
```
- The retry loop acquires `this.lock` (`:675`), retries only on `isSqliteBusy` (`:691`), and sleeps a jittered backoff with the lock released (`:700`).
- Inside an open transaction (`txContext` store, `:664-668`), the statement runs immediately with no retry.
- `BEGIN IMMEDIATE` is issued in `runTransactionAttempt`. `src/be/db-client.ts:525`: `this.shortSpin(db, () => db.run("BEGIN IMMEDIATE"), finalAttempt);`
- `readOnly` transactions use a deferred `BEGIN` at `:517` and opt out of BUSY retry (`:189-194`).
- A BUSY at COMMIT is retried with the transaction left open (`:539-542`, `:738-748`).

#### 2. claimKv lease release, refresh and handover

Neither site refreshes a lease in place. Both claim with a short TTL, then overwrite with a longer TTL on success, or delete on failure. Neither lets the claim expire on purpose. `src/comb/review-batch.ts:328-334` claims `status: "pending"` with `PENDING_CLAIM_MS`, and `settleClaims` (`:347-369`) then settles it:
```ts
const entry = await getKv(SENT_KV_NAMESPACE, id);
if (entry && claimToken(entry) !== claim) return false;
if (next) { await upsertKv({ ..., value: next, expiresAt: Date.now() + SENT_CLAIM_MS }); }
else if (entry) { await deleteKv(SENT_KV_NAMESPACE, id); }
```
- The settle step checks the claim token inside `getDbClient().transaction` (`:354-356`). A row now owned by another send is left alone.
- `src/slack/external-channel.ts:219-225` claims `"sending"` with `ALERT_SENDING_TTL_MS`.
- `settleAlert` (`:232-244`) then calls `upsertKv("sent", ALERT_DEDUPE_MS)` on success or `deleteKv` on failure. There is no token check there.
- `claimKv` itself (`src/be/db.ts:14053-14071`) is one conditional `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= ?`. It returns true when the key was absent or expired.
- `sweepExpiredKv` runs at `src/slack/external-channel.ts:286`. Its comment says `kv_entries` has no background sweep.

#### 3. POST /api/schedules: RBAC, auth and one-time lifecycle

The route def declares no `rbac` field. `src/http/schedules.ts:107-148` has `method`, `path`, `body` and `responses` only:
```ts
const createSchedule = route({
  method: "post",
  path: "/api/schedules",
  pattern: ["api", "schedules"],
```
- The only `rbac` field in the file is `ungated` at `:261-263`, on the PATCH def (`patchSchedule`): "bearer-authenticated agents may manage schedules".
- The create handler (`:322-499`) uses `authorizeHttpAssetKeyWrite(req, myAgentId, body.key, trustedUserId)` (`:444`) for keyed assets. `can()` appears only at `:608` and `:629`, in other handlers.
- A one-time schedule is disabled, not deleted. In the claim step, `src/scheduler/scheduler.ts:378-389` sets `nextRunAt = null` and `...(schedule.scheduleType === "one_time" ? { enabled: false } : {})`.
- Manual run does the same, with a log of "auto-disabled" (`:705-713`).

#### 4. kv_entries created_by / updated_by

Nothing populates them. `src/be/migrations/082_user_audit_fields.sql:76-77` only adds the columns, and I found no trigger in that file. The writers omit them: `src/be/db.ts:14032`, in `upsertKv`:
```sql
INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
```
- `claimKv` (`:14064`) uses the same column list, so both columns stay NULL.
- Other tables do write `created_by` and `updated_by` explicitly, for example `src/be/db.ts:3020`.

#### 5. getScriptApiTypes / getScriptMcpTypes

Both are in `src/be/script-connections.ts`, take `{agentId?, repoId?}`, and filter through `listScriptConnections(context)`.
- API (`:2186-2198`) keeps kinds `openapi`, `graphql` and `sql`. It emits each connection's stored `generatedTypes` block, then a registry interface. With no blocks it emits `export interface ScriptApiRegistry {}`.
```ts
`  ${connection.slug}: ${pascal(connection.slug)}Api;`
```
- MCP (`:2200-2210`) calls `listScriptConnections({ ...context, kind: "mcp" })` and emits `ScriptMcpRegistry` members as `${pascal(slug)}Mcp`.
- Per-agent filtering lives entirely inside `listScriptConnections`, which I did not read.
- The callers are `src/http/scripts.ts:1065-1071`, which pass `{ agentId: agent.id }`, and `src/be/scripts/typecheck.ts:1594-1595`.

#### Gaps
- I did not read `listScriptConnections`, so the exact agent and repo scoping rules are unverified.
- I did not trace which global auth middleware covers an `rbac`-less POST route, or whether `check:rbac-coverage` exempts it.
- I did not read the schedule handler body after `:351`, so I can't say whether it calls `can()` at all.
- I did not confirm whether request-auth context reaches `upsertKv`. Its signature takes no user input.
- I did not check for triggers outside migration 082.

### 12. Open questions: run rows, finish events, user run path, QuickJS ctx

#### 1. POST /api/script-runs: kind and execution
`createScriptRun` inserts without a `kind` column, so the column default applies. Migration 085 sets that default to `'workflow'`, and the CHECK allows only `workflow` or `inline` (`src/be/migrations/085_script_runs_kind.sql:6-7`).
```sql
ADD COLUMN kind TEXT NOT NULL DEFAULT 'workflow'
CHECK(kind IN ('workflow', 'inline'));
```
`recordInlineScriptRun` hardcodes `'inline'` in its INSERT (`src/be/db.ts:14464`). The route inserts the row inside a transaction with the concurrency cap check (`src/http/script-runs.ts:490-503`). When `parsed.body.background` is set, it calls `startScriptRunProcess(run, getMcpBaseUrl(), bearerToken(req))` (`:510-511`). That function lives in `src/script-workflows/supervisor.ts:34`. It reads the sealed args, calls `scriptExecutor.start(...)` (default `localProcessScriptExecutor`), then writes status `running` and the pid (`:50-58`). On exit it writes `completed` or `failed` through `updateScriptRunIfRunning` (`:76`).

Paused runs: the harness POSTs `{status:"paused"}` to the status route (`src/http/script-runs.ts:102`). The route keeps `finishedAt` null for a pause (`:682`). `pauseScriptRunProcess` also sets `paused` (`src/script-workflows/supervisor.ts:108-111`). `getRunningScriptRuns` selects `running` and `paused` rows (`src/be/db.ts:14698`), but `reconcileScriptRuns` skips paused ones (`supervisor.ts:126`). I found no code that moves a run from `paused` back to `running`. The only callers of `startScriptRunProcess` are the POST route and `reconcileScriptRuns` (`supervisor.ts:136`).

#### 2. Run-terminal events and listeners
```ts
export const WORKFLOW_RUN_FINISHED_EVENT = "workflow.run.finished";
```
(`src/be/db/workflow-runs.ts:666`)

Two bus events cover run termination. Both are emitted after commit, through a dynamic import of `workflowEventBus` (`:689-702`):
- `workflow.run.finished` carries `{runId, workflowId, status}`. `emitRunFinished` fires it only for terminal statuses (`:680-687`).
- `workflow.child.finished` carries `{childRunId, parentStepId}` (`:661-663`).

Callers are `src/be/db.ts:8146-8148`, `cancelLiveWorkflowTreeRuns` (`workflow-runs.ts:497`) and `src/be/automation-preflight.ts:446`.

Listeners:
- `src/workflows/resume.ts:186` listens for `workflow.child.finished` (`onChildRunFinished`).
- `resume.ts:1323` registers a generic per-event wait listener (`subscribeWaitToBus`) for event-mode `wait` nodes. The comment at `workflow-runs.ts:676-678` says waiters use scope `global` and filter on `runId`.
- `src/workflows/index.ts:71` subscribes to `EVENT_TRIGGER_NAMES`. I did not check whether that list includes `workflow.run.finished`.

`src/types.ts:2172-2173` lists `workflow.run.start` and `workflow.run.end`. I did not trace them. The bus is `InProcessEventBus` over `realtimeBus`, and it scrubs top-level strings on emit (`src/workflows/event-bus.ts:24-33`).

#### 3. runScriptForUser vs the agent path
`runScriptForUser` is defined in `src/be/scripts/user-code-mode.ts:76`.
- It requires exactly one of `name` or `source` (`:82`).
- It resolves only global-scope scripts (`:90`).
- It refuses secrets in inline source (`:95`).
- It rejects `workspace-rw` with a 501 (`:98`).
- It runs `runScriptAsUserWithRunCredential` (`src/be/scripts/run-credential.ts:99-130`).
- It writes a terminal `inline` row through `recordInlineScriptRun` (`:117`).

The agent path, `runScriptWithRunCredential`, mints a per-run token bound to the executing agent. That token carries optional provenance and is revoked in `finally` (`run-credential.ts:81-91`). The user variant mints a token bound to `userId` (`:113`). Its `runScript` call passes these overrides:
```ts
agentId: "",
egressSecrets: [], failedBindings: [], userConfig: {},
apiConnections: [], mcpConnections: [],
```
(`:119-125`). The row's `agentId` is the sentinel `"user-mcp"` (`user-code-mode.ts:19,119`), with `requestedByUserId` and `createdBy` set to the user.

#### 4. Which callers record script_runs rows
`runScriptWithRunCredential` and `runSavedScriptAsAgent` write no row themselves (`run-credential.ts:81-91`, `run-saved.ts:20-77`). The latter only builds credentials and connections, touches the scratch timestamp, and calls the former.

Callers of `recordInlineScriptRun` are:
- `src/http/scripts.ts:915`
- `src/scheduler/scheduler.ts:171`
- `src/http/x.ts:287`
- `src/be/scripts/user-code-mode.ts:117`

The sole `createScriptRun` caller is `src/http/script-runs.ts:492`.

The workflow `swarm-script` executor calls `runScriptWithRunCredential` with `{ sourceStepId: meta.stepId }` (`src/workflows/executors/swarm-script.ts:132-153`) and records no row. Its agent id falls back to `agentId ?? "workflow"` (`:138`).

`runSavedScriptAsAgent` has these callers, with no row recorded: `src/ui-spec/script-actions.ts`, `src/apps/sync.ts`, `src/apps/action-runner.ts`, `src/heartbeat/heartbeat.ts`, `src/tasks/follow-up-gate.ts`.

A nested `ctx.swarm.script_run` records an inline row with `sourceStepId` and `parentScriptRunId` taken from `getCurrentRunProvenance()` (`db.ts:14455,14481-14484`).

#### 5. QuickJS guest-side ctx
The host builds `__swarm_shape` from the host ctx, as `{hasRuntimeInstanceId, api, mcp, fs, namespaces}` (`quickjs-runner.ts:553-559`). Each api/mcp entry maps a slug to its method names. The shape is injected in `swarm-init.js` (`:675`). Evaluation order is init, web shims, structured clone, prelude, user bundle, epilogue (`:677-682`).

Guest calls go through `hostCall(path, args)`, which JSON-stringifies the args and unwraps a `{value}` or `{error}` envelope into a thrown `Error` (`quickjs-prelude.ts:23-33`). `ctx.swarm` is a Proxy:
```js
get(target, prop) {
  if (prop in target) return target[prop];
  if (prop === "then") return undefined;
  return method("swarm." + prop);
}
```
(`quickjs-prelude.ts:428-435`). `room` and `config` are own members of the proxy target. Every other name becomes `hostCall("swarm.<name>")`. The `api`, `mcp`, `fs` and SDK namespaces are plain objects built from the shape (`:436-454`). The ctx is frozen (`:455`) and exposed as `__swarm_ctx` (`:469`).

On the host, `__host_call` runs `dispatchCall` through the `bridge` deferred-promise wrapper (`quickjs-runner.ts:621-632`). `ctx.swarm.<first>` resolves to `hostCtx.swarm[first]`, and inherited names are refused via `first in Object.prototype` (`:268-274`). Every `ctx.swarm.*` call runs inside `swarmHostCalls.run(true, ...)` (`:266,274`).

`structuredError(error, map)` (`:343`) matches stack frames with `FRAME_RE`. It remaps bundle-file frames through the source map and keeps those whose original source ends with `USER_SCRIPT_FILE` as `userFrames`. It returns `{name, message, stack, userFrames, userScriptLine, userScriptColumn, ctxSignatureHint?}` (`:343-377`).

#### 6. Native warm-harness spare
After each cold or warm spawn, `native.ts:533` calls `void startWarmHarness(specKey, spec)`, "Load the next run's harness while this one runs".
```ts
const WARM_IDLE_MS = 30_000;
const MAX_WARM_SPECS = 4;
```
(`native.ts:356-357`). `startWarmHarness` (`:405-445`) skips on win32 and when a spare or an in-flight warm for that key exists. Otherwise it creates a run dir, links the import shims, spawns the harness with `spawnHarness`, and calls `proc.unref()`. The spare blocks on stdin. It is discarded after 30 s idle, when the pool exceeds 4 specs (oldest dropped), or when the process exits.

`takeWarmHarness` (`:392`) removes the spare at the start of the next run with the same key (`:488`). `harnessSpecKey` (`:361-377`) covers the harness path, tmp dir, `runAs`, `hostValidatedArgs`, the resource limits, and the PATH, HOME, LANG and LC_ALL env values. Credentials arrive later on stdin (`:535`).

#### Gaps
- No code path resumes a `paused` script run. I did not check script-workflow harness files outside `src/script-workflows/`.
- I did not confirm which events `EVENT_TRIGGER_NAMES` contains, or whether anything listens for `workflow.run.finished` other than event-mode waits.
- The `workflow.run.start` and `workflow.run.end` entries in `src/types.ts:2172` are untraced.
- Where `namespaces` (`quickjs-runner.ts:558`) is derived from `SDK_NAMESPACES` was not read.
- `updateScriptRun` and `updateScriptRunIfRunning` internals were not read, so I did not check whether they emit events for script runs.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/scripts-runtime/eval-harness.ts` | 131-169 | Native default-function check, call, JSON result write |
| `src/scripts-runtime/executors/native.ts` | 62-76, 549-551 | Exit classification, result and error file reads |
| `src/scripts-runtime/executors/quickjs-bundle.ts` | 104 | Module namespace placed on `globalThis.__swarm_module` |
| `src/scripts-runtime/executors/quickjs-prelude.ts` | 477-626 | QuickJS epilogue: default check, call, JSON post |
| `src/scripts-runtime/executors/quickjs-runner.ts` | 675-718 | Evaluation order, timeout race, dispose |
| `src/scripts-runtime/loader.ts` | 38, 130-211 | `runScript`, capacity retry, scrubbing |
| `src/scripts-runtime/executors/types.ts` | 75-121, 131-142 | Error kinds, `ExecutorOutput`, drain and wall-clock constants |
| `src/be/scripts/typecheck.ts` | 936, 1590-1611 | `ScriptMain` type and the appended check file |
| `src/scripts-runtime/extract-signature.ts` | 43-75 | Default-function-only signature extraction |
| `src/be/scripts/db.ts` | 100-292 | Script and version writes (`signatureJson`, `argsJsonSchema`) |
| `src/be/db.ts` | 14021-14130 | `upsertKv`, `claimKv`, `deleteKv`, `incrKv` |
| `src/kv-reserved-namespaces.ts` | 7-70 | Reserved families, private families, `_room/` key guard |
| `src/tools/kv/kv-write-auth.ts` | 20-69 | Tool-path KV write guard |
| `src/http/kv.ts` | 369-390, 656-764 | HTTP-path KV write guard and per-key checks |
| `src/be/db.ts` | 14639-14678 | `updateScriptRun`, `...IfNotTerminal`, `...IfRunning` |
| `src/script-workflows/supervisor.ts` | 60-142 | Exit handler, limit abort, reconcile |
| `src/http/script-runs.ts` | 420-431, 492-518, 578-591, 664-689 | Limits, launch, cancel, status route |
| `src/be/db-client.ts` | 120, 548-603 | `afterCommit` queueing and hook scheduling |
| `src/workflows/event-bus.ts` | 6-71 | `workflowEventBus` API and instance |
| `src/be/scripts/run-credential.ts` | 54-91 | Per-run token mint and revoke |
| `src/be/users.ts` | 746-771, 1057-1117 | `mintScriptRunToken`, provenance resolution |
| `src/be/db.ts` | 14432-14490 | `recordInlineScriptRun` (row inserted already terminal) |
| `src/workflows/executors/sub-workflow.ts` | 33-34, 105-115 | `MAX_SUB_WORKFLOW_DEPTH`, lineage and cycle check |
| `src/tools/script-run.ts` | 50-90 | `script-run` tool input, proxy to `/api/scripts/run` |
| `src/http/scripts.ts` | 606-617, 757-840 | Script resolution, run handler, nested provenance |
| `src/scheduler/scheduler.ts` | 78-171 | Script-target schedule dispatch |
| `src/workflows/executors/swarm-script.ts` | 29-264 | Node config, source resolution, execution |
| `src/apps/definition.ts`, `src/apps/action-runner.ts` | 350-362, 61-92 | App script action schema and runner |
| `src/be/migrations/102_script_apis.sql`, `src/http/x.ts` | 11-31, 72-287 | Endpoint table and public invoke route |

## Open Questions

All nine first-round questions were checked on 2026-11-17 (round 2). Full reports: sections 11 and 12 above.

| # | Question | Answer |
|---|---|---|
| 1 | How does a lone `getDbClient().run/get` handle BEGIN? | No BEGIN. One autocommit driver call under a FIFO lock, retried on `SQLITE_BUSY` with jittered backoff (`db-client.ts:675-700`). Inside `transaction()` it runs at once with no retry. `BEGIN IMMEDIATE` is issued in `runTransactionAttempt` (`:525`). |
| 2 | How do comb and slack release `claimKv` leases? | Both claim with a short TTL, then on success `upsertKv` with a longer TTL, or on failure `deleteKv`. Comb checks its claim token inside a transaction before settling (`review-batch.ts:347-369`). Slack does not check a token (`external-channel.ts:232-244`). Neither refreshes in place. |
| 3 | Where are `kind: "workflow"` rows created, and where do paused runs resume? | `createScriptRun` omits `kind`, so the migration 085 default `'workflow'` applies (`script-runs.ts:490-503`). No code moves a run from `paused` back to `running`. `reconcileScriptRuns` skips paused rows (`supervisor.ts:126`). |
| 4 | Run-terminal bus events? | `workflow.run.finished` (`{runId, workflowId, status}`, `workflow-runs.ts:666,680-687`) and `workflow.child.finished`. Both are emitted after commit. These are for workflow runs, not script runs. No script-run event exists. |
| 5 | What is `runScriptForUser`? | `user-code-mode.ts:76`. Global scripts only. It mints a user-bound token through `runScriptAsUserWithRunCredential` (`run-credential.ts:99-130`) with empty connections and secrets, and records an `inline` row with agent sentinel `"user-mcp"`. |
| 6 | RBAC on `POST /api/schedules`? | The route def declares no `rbac` field (`schedules.ts:107-148`). Keyed assets are checked through `authorizeHttpAssetKeyWrite` (`:444`). One-time schedules are disabled (`enabled: false`) after the fire, not deleted (`scheduler.ts:378-389`). |
| 7 | Do workflow-step or `run-saved` runs get a `script_runs` row? | No. `runScriptWithRunCredential` and `runSavedScriptAsAgent` write no row. Rows come only from `recordInlineScriptRun` (`scripts.ts:915`, `scheduler.ts:171`, `x.ts:287`, `user-code-mode.ts:117`) and `createScriptRun` (`script-runs.ts:492`). `runSavedScriptAsAgent` callers with no row: App actions, UI-spec script actions, app sync, heartbeat, follow-up gate. |
| 8 | QuickJS guest ctx and the warm harness? | Guest `ctx.swarm` is a Proxy that turns every unknown name into `hostCall("swarm.<name>")` (`quickjs-prelude.ts:428-435`). The ctx is frozen. Native pre-spawns one warm harness per spec key after each run (`WARM_IDLE_MS = 30_000`, `MAX_WARM_SPECS = 4`, `native.ts:356-445`). Credentials arrive later on stdin. |
| 9 | What do the type contributors emit? | API and MCP: each connection's stored `generatedTypes`, plus a `ScriptApiRegistry` / `ScriptMcpRegistry` keyed by slug, filtered by `listScriptConnections(context)` (`script-connections.ts:2186-2210`). Apps: `App_<Name>` namespaces for all apps, context ignored, capped at 32 KiB (`apps/script-types.ts:5,292-302`). |

Extra fact found on the way: `kv_entries.created_by` / `updated_by` are never populated. No writer sets them and migration 082 has no trigger.

Residual gaps (not blocking): `listScriptConnections` scoping rules; whether `EVENT_TRIGGER_NAMES` includes `workflow.run.finished`; RBAC on `script_run` for `ext:<name>` agents; `src/http/pages.ts` CRUD and RBAC details.

## Appendix

- **Architecture notes:**
  - The API owns the DB. Workers and the script runtime reach it over HTTP with a per-run token (CLAUDE.md invariant).
  - Post-commit work uses `getDbClient().afterCommit`, never microtasks.
  - The KV write guard is duplicated across the tool and HTTP paths, and both read one registry (`src/kv-reserved-namespaces.ts`).
- **Historical context (from thoughts/):**
  - `thoughts/taras/brainstorms/2026-11-17-durable-script-objects.md`: the design this research feeds.
  - `thoughts/taras/design-docs/swarm-apps.md`: the Swarm Apps design doc. Apps store model rows in KV and run script actions.
- **Related research:**
  - Async DB + query engine research, 2026-11-12 (memory note): no in-process SQLite driver on Bun is non-blocking. The plan is a Worker driver plus a dialect lint. Postgres is deferred.
