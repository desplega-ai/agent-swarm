---
date: 2026-11-17
researcher: Claude
topic: "Durable-object scripts PR 1: planning spikes (exact edit points)"
tags: [research, planning-spikes, scripts-runtime]
status: complete
---

# Planning spikes: durable-object scripts PR 1

Raw sub-agent reports gathered for [the PR 1 plan](../plans/2026-11-17-durable-objects-pr1-core.md). Facts only.

## executors

#### 1. SDK imports at runtime (native and QuickJS)

- The static check is `validateScriptImports` in `src/scripts-runtime/import-allowlist.ts:170-175`. It allows only the bare specifiers `swarm-sdk`, `stdlib`, `zod`, `zod/mini` (`:3`), plus relative paths. It checks import and export declaration specifiers, not `export default class`, so a class default export passes.
- Native resolves bare imports through shim packages written to `<tmpdir>/node_modules/<name>` (`src/scripts-runtime/executors/native.ts:157-213`). The `index.ts` shim re-exports the target module. There are two target tables:
  - Dev mode (`:172-180`): `["swarm-sdk", new URL("../swarm-sdk.ts", import.meta.url)]`.
  - Compiled mode (`:189-194`): `["swarm-sdk", `${runtimeDir}/swarm-sdk.bundle.js`]`.
- `extract-args-schema.ts:23-26` and `src/extensions/loader.ts:58` repeat the same shim mapping. Any new bundle entry or file must be mirrored there too.
- A runtime value `DurableObject` for native would be a new `export class` in `src/scripts-runtime/swarm-sdk.ts`. That file currently exports only functions: `createSwarmSdk` (`:751`), `createNamespaceClients` (`:787`), `isReadOnlyBridgeCall` (`:537`).
- The compiled bundle comes from a build step I did not read. Check how `swarm-sdk.bundle.js` is produced.
- QuickJS uses esbuild-style virtual modules in `src/scripts-runtime/executors/quickjs-bundle.ts`.
  - `:30-33` reads `const SWARM_SDK_MODULE = \`export function createSwarmSdk() { return globalThis.__swarm_ctx.swarm; }\``.
  - `:117-123` routes `/^(stdlib|swarm-sdk)$/` to namespace `swarm-virtual` and picks `STDLIB_MODULE` or `SWARM_SDK_MODULE`.
  - The `DurableObject` class has to be added as source text inside the `SWARM_SDK_MODULE` string. It cannot import `swarm-sdk.ts`.
- The bundle cache key is `Bun.hash(source)` (`:89`), so a change to the module text does not invalidate old entries within a process.
- Options: duplicate a minimal base class in both places (native file plus QuickJS string), or have `SWARM_SDK_MODULE` read a class defined in the prelude and exposed on `globalThis`. The precedent is `define("__swarm_ctx", ctx)` and `define("__swarm_stdlib", stdlib)` (`quickjs-prelude.ts:468-469`).

#### 2. Per-run input channels

- `SwarmConfigPayload` is at `src/scripts-runtime/executors/types.ts:16-43`:
  ```ts
  export type SwarmConfigPayload = {
    system: { apiKey; agentId; mcpBaseUrl; runtimeInstanceId?; auditSourceTaskId?; extensionToken? };
    user: Record<string, { value: string; isSecret: boolean }>;
    egressSecrets?; failedBindings?; apiConnections?; mcpConnections?; agentFs?: ScriptAgentFsDescriptor;
  };
  ```
- The host builds it in `loader.ts:102-128`, and it reaches the child as native stdin (`native.ts:535`, `child.stdin.write(JSON.stringify(input.configPayload))`). QuickJS gets it through `job.configPayload` (`quickjs.ts:206`).
- It carries identity, config and credentials, and `agentFs` is a precedent for a small non-secret descriptor (`types.ts:14`).
- Args:
  - Native writes `args.json` (`native.ts:509`) and exposes its path as the env var `SWARM_SCRIPT_ARGS_FILE` (`:281`). The harness reads it at `eval-harness.ts:109-111`, and a string is JSON-parsed a second time.
  - QuickJS injects `globalThis.__swarm_args = ${JSON.stringify(args)}` in the init snippet (`quickjs-runner.ts:675`).
- Flags are passed as `SWARM_SCRIPT_HOST_VALIDATED_ARGS=1` (`native.ts:286`) or `__swarm_host_validated_args` (`quickjs-runner.ts:675`). The plumbing is `ExecutorInput.hostValidatedArgs` (`types.ts:63`), `loader.ts:187`, and `quickjs.ts:205`.
- `ExecutorInput` (`types.ts:55-73`) is the shared contract. A new optional field, for example `object?: { method, id, state, codeVersion, caller }`, would need to be threaded in the same places as `hostValidatedArgs`.
- Choices the code allows for `{ method, objectId, state, codeVersion, caller }`:
  - Put it in the payload. This is stdin, and it is the only channel identical across both executors. `caller` is system context like `auditSourceTaskId`.
  - Put the state inside `args`, wrapped.
  - Add a new run-dir file. That is native-only, because QuickJS has no files.
- State can be large. The args file is bounded by `ulimit -f` (`maxFileBytes`, 64 MB default, `types.ts:145`).

#### 3. Epilogue and result serialization

- Native, `eval-harness.ts:131-169`. It imports the module (`:131`) and requires `typeof mod.default === "function"` (`:132`). It validates `argsSchema` (`:138-166`), then runs `:168-169`:
  ```ts
  const result = await mod.default(validatedArgs, ctx);
  await Bun.write(requiredEnv("SWARM_SCRIPT_RESULT_FILE"), JSON.stringify(result ?? null));
  ```
  - The `:132` check is the first place that rejects a class default export. A branch there would test whether `mod.default.prototype instanceof DurableObject`.
  - The host reads the file via `readResultFile` / `readRunDirFile` (`native.ts:100-142`, `:549`). It rejects a file larger than `maxBytes`, which makes the result `undefined`.
  - `JSON.stringify(result ?? null)` is also where `{ result, state, destroyed }` would be written.
- QuickJS, `quickjs-prelude.ts:574-600`. `const mod = globalThis.__swarm_module` (`:574`) and the same default-function check (`:575`). It then runs `return await mod.default(args, globalThis.__swarm_ctx);` (`:600`). The `.then` at `:601-625` builds `JSON.stringify({ ok: true, result })`, or an error envelope for a non-serializable result (`:607-611`), and calls `__host_done(json)`.
  - The host does `finish(JSON.parse(...))` (`quickjs-runner.ts:656-659`) and returns `output({ result: outcome.result, exitCode: 0 })` (`:699`).
- I found no explicit result-size cap in QuickJS. The only caps in the executors directory are fetch-body limits (`quickjs-runner.ts:66-68`) and `MAX_STACK_BYTES`. Native is bounded by `maxFileBytes`.
- After the run, `loader.ts:202-204` scrubs `output.result` with `scrubObject(runSecrets.object(...))`. If `state` is returned inside `result`, the scrubber would touch it before the host commits.

#### 4. ctx construction

- Native, `ctx.ts:37-67`. `buildCtx({ swarmConfig, apiConnections, mcpConnections, agentFs, signal, namespaces })` returns `{ ...namespaceClients, swarm, api, mcp, fs, sh, stdlib, logger }`. The type is `RuntimeCtx` (`:21-35`) with an index signature `[namespace: string]: unknown`. It is called at `eval-harness.ts:112-117`. `ctx.caller` would be a new parameter on `buildCtx` fed from the payload.
- QuickJS, `quickjs-prelude.ts:455`:
  ```js
  const ctx = Object.freeze({ ...namespaces, swarm, api: registry("api"), mcp: registry("mcp"), fs, sh, stdlib, logger: console });
  ```
  - `ctx` is frozen and published as `__swarm_ctx` (`:469`).
  - `caller` is plain JSON data, so it could be passed like `__swarm_args` in the init snippet (`quickjs-runner.ts:675`) and read here. Its type is `{ agentId, taskId?, objectChain? }`-like, but that shape is not defined anywhere yet.
- `RESERVED_CTX_KEYS` (`sdk-allowlist.ts:291-302`) is `swarm, api, mcp, fs, sh, stdlib, logger, run, step, config`. `caller` is not reserved, so it must be added to prevent a namespace shadowing it (`assertNamespaces`, `:311-314`).
- `run` and `step` are already reserved and typed as optional (`typecheck.ts:900-901`), but `buildCtx` does not set them. They are presumably injected elsewhere, for workflow-run scripts. I did not trace that code.

#### 5. Typecheck ambient

- `SCRIPT_SDK_TYPES` is a template literal starting at `typecheck.ts:32`. `ScriptContext` is `:899-922`, with typed namespace keys at `:915-921`. `ScriptMain` is `:936`:
  ```ts
  export type ScriptMain = (args: any, ctx: ScriptContext) => unknown | Promise<unknown>;
  ```
- The typecheck harness is at `:1597-1607`. It builds `modules: { "swarm-sdk": sdkTypes, stdlib: stdlibTypes }` and adds a synthetic `import type { ScriptMain } from "swarm-sdk"; const _scriptMain: ScriptMain = run;`. A class default export would fail that assertion, so a branch or union is needed here.
- `declare abstract class DurableObject<S>` plus a `caller` field on `ScriptContext` would go inside `SCRIPT_SDK_TYPES`, next to `ScriptContext` (`:899`). It is then inherited by:
  - `scriptSdkTypesWithGeneratedApis` (`:939-947`), the flat virtual file.
  - `stdlibTypesFor` (`:993-998`), which wraps it in `declare module "swarm-sdk" { ... }` for Monaco.
- `scripts/bundle-script-types.ts:43-48` writes `src/scripts-runtime/types/swarm-sdk.d.ts` and `stdlib.d.ts` from these constants and formats them with biome. CI checks drift with `check:script-types` (`package.json:132`). The generated files are never hand-edited.
- `src/be/extensions/validate.ts:87` also feeds `SCRIPT_SDK_TYPES` to extensions as `"swarm-sdk"`.

#### Gaps

- I did not read the build step that makes `swarm-sdk.bundle.js` and the other `*.bundle.js` files in compiled mode.
- I did not locate where `ctx.run` and `ctx.step` are populated for workflow runs.
- I did not read `quickjs-runner.ts:28-35` or the worker message type in full. A new field on the QuickJS job type must be added there and in `quickjs.ts:202-209`.
- `extract-signature.ts`, `extract-args-schema.ts` and `quickjs-compat.ts` assume a function default export. I did not trace how they behave for a class.
- No QuickJS result-size limit was found, and no `maxFileBytes`-like cap applies to the QuickJS post.

## run-upsert

#### 1. Run route and handler (`src/http/scripts.ts`)
- Request schema `runBodySchema` (77-90): `name?, source?, args?, intent, scope?, fsMode, executor?, idempotencyKey?`, with a `.refine` for exactly one of name/source.
```ts
.refine((body) => Boolean(body.name) !== Boolean(body.source), {
    message: "Provide exactly one of name or source",
```
  An `object: z.object({ id, method }).optional()` would be added at 77-87. A second refine (object requires name) could sit next to the existing refine.
- Route def `runRoute` (262-283): `route({ method:"post", path:"/api/scripts/run", pattern, auth:{userNamesAgent}, operationId:"scripts_run", headers: runtimeInstanceHeader(..), body: runBodySchema, responses })`. The 200 schema is `scriptRunResponseSchema`. There is no `rbac` key, because the existing run route is a POST with no `rbac` (upsert has `rbac: { permission: "script.global.write" }` at 259).
- Handler starts at 754. Steps: `requireAgent` (757), `runtimeInstanceId` and `sourceTaskId` headers (763-769), secret refusal for inline source (773), named resolve at 783-793, then `workspace-rw` 501 (795), executor allow-check (800), `startedAt` (809), scratch touch (812), credentials (815).
- Named vs inline: named does `resolveScript(name, agent.id, scope)` (784). It sets `namedScript`, `source`, `fsMode`, and `executor`, and returns 404 if missing. Inline keeps `parsed.body.source`.
- `resolveScript` (606-617): scope "global" gives `getScript({name, scope:"global"})`. Otherwise it tries agent scope, then global. A DO call must pin `scope: "global"` or check `script.scope === "global"` after resolve, because the default resolves agent scope first.
- Execution call (816-840):
```ts
const runId = crypto.randomUUID();
const callerProvenance = getCurrentRunProvenance();
const output = await runScriptWithRunCredential(
  { source: source as string, args: parsed.body.args, fsMode, executor, agentId: agent.id, ...},
  { sourceScriptRunId: runId, sourceStepId: callerProvenance?.sourceStepId ?? undefined },
);
```
  The lease/load/commit wrapper would wrap lines 816-840: load state, claimKv, run, then commit. `ok` is computed at 841. Commit must follow `ok`, so the transaction goes after 841 and before the scratch handling (843) and `idempotencyKey` KV write (858).
- Provenance: `ScriptRunProvenance = { sourceStepId?, sourceScriptRunId? }` (`src/be/scripts/run-credential.ts:44`). `mintScriptRunToken(agentId, TTL, provenance)` is at line 61. `getCurrentRunProvenance()` is the nested-run reader. `objectChain/depth` would extend this type and the `session_tokens` columns. It is a third positional arg at 836-839.
- `recordInlineScriptRun` (915-929) takes `id: runId, agentId, source, args: scrubObject(args ?? null), scriptName: parsed.body.name ?? "(inline source)", status, output: scrubObject(output.result), error: runError, startedAt, finishedAt`. It is wrapped in a swallow-all try/catch. It has no object-id field, so `scriptName` is the only place to put one without a schema change.
- Response (934-): `runRoute.respond(res, 200, scrubObject({ result, autoSaved, kvSaved, truncated, durationMs, stdout, stderr, exitCode, error, runtimeError }))`. `scriptRunResponseSchema` (167-204) has no object field. Adding `object: { id, destroyed }` optional requires editing it.
- `upsertKv` is already imported (7) and used at 867 with `{namespace, key, value, valueType:"json", expiresAt:null}`. `claimKv` was not searched here. Its location and signature are unconfirmed (see Gaps).

#### 2. MCP tool and SDK
- `src/tools/script-run.ts:55-83` is a `z.object` inputSchema: `name, source, args, intent, scope, fsMode, executor, idempotencyKey`. An `object` field goes after 82. It proxies verbatim: `proxyScriptsApi({ method:"POST", path:"/api/scripts/run", body: args, ... })` (87-93). It needs no change beyond the schema, apart from a note in `SCRIPT_RUN_DESCRIPTION` (14) and `renderRunOutput` (16-46, which reads `result/stdout/durationMs/autoSaved/kvSaved`).
- SDK REST mapping `src/scripts-runtime/swarm-sdk.ts:247-248` forwards the whole body. `case "script_run": return { method:"POST", path:"/api/scripts/run", body };` The SDK needs no change. There is a name-check at 720 (`script_search || script_run`).
- Typings: `src/be/scripts/typecheck.ts:480` hand-lists the args:
```ts
script_run(args: { name?: string; source?: string; args?: unknown; intent?: string; scope?: ScriptScope; fsMode?: ScriptFsMode; executor?: ScriptExecutorName | null; idempotencyKey?: string }): Promise<unknown>;
```
  Add `object?: { id: string; method: string }` here. Then run `bun run build:script-types` (`package.json:95` runs `bun scripts/bundle-script-types.ts`). That regenerates `src/scripts-runtime/types/swarm-sdk.d.ts:595` and `stdlib.d.ts:637`. The tool is mapped in `sdk-allowlist.ts:76` (`script_run: "script-run"`). Per CLAUDE.md, do not edit the `.d.ts` files by hand.

#### 3. Upsert
- Schema `upsertBodySchema` (67-75): `name, source, description, intent, scope(default "agent"), fsMode, executor`. Route at 230-260 with `rbac: { permission: "script.global.write" }`.
- Handler order (659-752): parse, `requireAgent`, a global-scope lead check via `can()` (667-678, 403), executor allow (680), `refuseSourceWithSecrets` (689), `typecheckScript` (695), `resolveHttpAuditUserId` (709), `existingAgentScript` (711), `extractArgsJsonSchema` (715), `upsertScriptByName` (716-731), global event (733), `quickJSCompatWarnings` (742), respond (745).
- Scope is decided only by `parsed.body.scope`. The db layer receives `scope` and `scopeId: scope==="agent" ? agent.id : null` (719). In `db.ts`, `insertScript` calls `normalizeScopeId(args.scope, args.scopeId)` (123).
- Refusal placement options. The existing precedent is `json(res, secretRefusal, 400)` at 689-693 (`refuseSourceWithSecrets`). It sits before the typecheck and returns an early 400. A DO-detection check using the TS AST could go between 693 and 695. Alternatively, `ScriptSignature` (extract-signature.ts:3-7, `{argsType, resultType, description}`) could gain a kind field. `extractScriptSignature` (50-81) only recognizes `export default function` (65) and `export default <arrow|function expression>` (69-72), and falls back to `FALLBACK_SIGNATURE` for a class. Signature is stored via `signatureJsonFor(source)` (602-604, called at 723 and 887). It goes into the `signatureJson` column (db.ts:148, update 231/283) and into `script_versions` (db.ts:99-111).
- `signatureJson` callers outside http: `src/be/seed-scripts/index.ts:471`, `src/be/import/dir-source.ts:293`, `src/be/extensions/assets.ts:336`. All call `extractScriptSignature` directly, so a refusal inside the extractor or db layer would hit these too. A refusal in the HTTP handler would hit none of them.
- The inline run path auto-saves as agent-scope scratch (880-894), so a source with a DO class run inline would be saved at agent scope with no refusal unless the run handler checks.
- MCP tool `src/tools/script-upsert.ts:23-43` mirrors the body schema and proxies to `/api/scripts/upsert` (46-66). The `source` description (28-30) says "Must `export default async function (args, ctx)`", which would need a DO exemption note.

#### 4. NUDGES (`src/tools/utils.ts`)
- Shape (434): `export const NUDGES: Record<string, (result: SwarmToolResult) => string | undefined>`.
- Entries (436-441):
```ts
"defer-task": (r) => r.ok ? "Stop working on this task now; ..." : undefined,
"script-run": scriptRunNudge,
"script-upsert": scriptAuthoringNudge,
```
- `scriptRunNudge` (285-290) reads `r.data.data.error`, and returns `SCRIPT_RUN_TIMEOUT_NUDGE` or falls back to `scriptAuthoringNudge` (280-283, a regex on `r.message`). `nudgeMiddleware` permits one steer per result (comment at 287), so a DO nudge must be chained inside `scriptRunNudge` or `scriptAuthoringNudge`.
- Lookup is at 523: `NUDGES[ctx.toolName]?.(result)`.

#### 5. OpenAPI
- Both routes use the `route()` factory. CLAUDE.md requires `schema:` on every 2xx, and `rbac` on non-GET routes. Run has no `rbac` key today. Run `bun run docs:openapi` (`package.json:178`, `scripts/generate-openapi.ts`). Commit `openapi.json` and `docs-site/content/docs/api-reference/**`. CI also runs `check:openapi-response-coverage` (131) and `check:vendored-openapi` (128). No new handler file is needed, so `all-routes.ts` is untouched.

#### Gaps
- I did not locate `claimKv`, the `session_tokens` columns or `mintScriptRunToken` internals, or `getCurrentRunProvenance`'s source file.
- I did not read `scriptToolOutputSchema` in `script-common.ts` or `proxyScriptsApi`.
- I did not read `src/scripts-runtime/loader.ts` `RunScriptOutput`. A `{result, state, destroyed}` return would need a harness or loader change that I have not inspected.
- I did not confirm whether `rbac` is required on `/api/scripts/run` per `check:rbac-coverage`. The route has none today.
- `bundle-script-types.ts` has no `script_run` string. The args type comes from `typecheck.ts` `SwarmSdk`, not from the MCP zod schema. I did not check whether the build also derives from the MCP registry.

## kv-guard

#### Answers for the "durable" KV family

#### 1. `src/kv-reserved-namespaces.ts` (71 lines)
- `RESERVED_FAMILIES` is a `Map<string,string>` at lines 7-29. It maps the family name to the write-denial message. Example: `["worker", "namespace is reserved for worker nudges"]` (line 17).
- Matching: `reservedNamespaceError(namespace)` (line 55) takes `namespace.split(":", 1)[0]`, so `durable:<scriptId>` resolves to family `durable`.
  ```ts
  return RESERVED_FAMILIES.get(namespace.split(":", 1)[0] ?? "") ?? null;
  ```
- `isReservedNamespace` (line 51) is `reservedNamespaceError(...) !== null`.
- Reserved families are readable but not writable by default. The header comment says "may read these namespaces for inspection, but must not mutate them" (lines 1-6).
- `PRIVATE_FAMILIES = new Set(["session-labels", "slack-thread-buffer"])` (line 37) blocks reads too. `privateNamespaceError(ns)` (line 60) returns the reserved message only for families in that set. A private family must also be in `RESERVED_FAMILIES`.
- `LEAD_ONLY_FAMILIES` (line 44) with `requiresLeadToWrite` (line 47) is a separate set that gates writes to the Lead.
- `reservedRoomKeyError(key)` (line 66) is a key-level guard for `_room/`.
- The write guards that call `reservedNamespaceError` are `src/http/kv.ts:373` (`authorizeWrite`) and `src/tools/kv/kv-write-auth.ts:29`.
- The internal helpers `getKv`, `upsertKv`, `claimKv` and `deleteKv` in `src/be/db.ts` do not check reservation. Internal subsystems write through them directly.

#### 2. Read paths and gate insertion points
- `src/tools/kv/kv-read-auth.ts:10-15` is the MCP seam. It is sync and takes only `agentId`:
  ```ts
  return privateNamespaceError(namespace) ?? mcpOverflowAuthError(namespace, info.agentId);
  ```
- It is called from `kv-get.ts:183` and `kv-list.ts:67`. Both pass `{ agentId: requestInfo.agentId }` and return `toolErr(authErr, ...)`.
- `src/http/kv.ts:421-428` has a separate `authorizeRead(namespace, ctx)`. It repeats the same two-term `??` and returns `{status:403,message}`.
- `authorizeRead` is called from `sendGet` (line 686) and `sendList` (line 786). `buildAuthCtx` (line 346) supplies `callerAgentId` from the `x-agent-id` header, a `hasPageHeader` flag and an `isLead` flag. It is async because it calls `getAgentById`.
- The HTTP and MCP read gates are two independent copies. A durable gate has to be added to both, or both have to call one new shared helper.
- Options:
  - (a) Mark `durable` private (blocks all generic reads).
  - (b) Add a third `??` term, in the style of `mcpOverflowAuthError` from `@/kv-overflow`. It would parse `durable:<id>` and check run access. A script lookup is async, so `kvReadAuthError` and `authorizeRead` would have to become async. The MCP callers can already `await`. The HTTP callers already `await buildAuthCtx`.
- Precedent for per-owner namespaces: `mcpOverflowAuthError(namespace, agentId)`, which compares the caller to the agent id embedded in the namespace.

#### 3. "Can run this script" today
- No helper exists that checks whether an agent may run a given `scriptId`.
- `src/http/scripts.ts:589-600`: `requireAgent(res, agentId)` returns 400 if the header is missing, 404 if `getAgentById` finds no agent, else the agent. It is a presence check only.
- The run route is at `scripts.ts:754-793`.
  - `agent = await requireAgent(...)` at line 757.
  - `resolveScript(name, agent.id, scope)` at line 784.
  - Visibility is therefore scope-based. `resolveScript` (lines 606-617) looks up agent scope first (`scopeId: agentId`), then global. Any authenticated agent can run any global script.
  - No `can()` call is made on run. `can({... resource:{kind:"owned", scope:"global"}})` appears only on upsert (about line 667) and delete (about line 1087).
- `src/be/scripts/db.ts`:
  - `getScript(args: ScriptIdentity)` at line 335 matches by name, scope and scopeId.
  - `getScriptById(id: string)` at line 362 is `SELECT * FROM scripts WHERE id = ?`. It does no scope check.
  - `getScriptById` is used by the dashboard reads (around line 1019) and by script-API creation (line 1140).
- A saved global script is runnable by any agent. A "can run" gate for a global durable class reduces to "script exists and is global", or to an agent-scope check on `script.scopeId === agentId`. Agent-scope scripts have `scopeId` equal to the owner.
- The dashboard reads at `scripts.ts:970` use API-key auth only, with no `requireAgent`.

#### 4. `scrubSecrets` on KV read egress
- There is none. `src/http/kv.ts` and `src/tools/kv/*` contain no scrubber import.
- `sendGet` returns `entry` as stored (lines 691-705). `sendList` returns `listKv` rows (lines 794-796).
- Scrubber location: `src/utils/secret-scrubber.ts`.
  - `scrubSecrets(text: string | null | undefined): ScrubbedText` at line 1261.
  - `scrubObject<T>(...)` at line 1578.
- `src/http/scripts.ts:61` imports both with `import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";`. It is the nearest precedent for HTTP egress (use at line 903).
- `kv-get` already has a result-spill path in the registrar (see CLAUDE.md MCP section). That is unrelated to scrubbing.

#### 5. Internal KV helpers (`src/be/db.ts`)
- `getKv(namespace, key): Promise<KvEntry | null>` at line 13950.
  - It deletes expired rows inline (lines 13957-13962).
- `upsertKv(input: {namespace; key; value: unknown; valueType: KvValueType; expiresAt?: number|null}): Promise<KvEntry>` at line 14021.
  - It is `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`.
- `claimKv(input: same shape): Promise<boolean>` at line 14053.
  - It does an insert, or an update only when the existing row is expired:
    ```sql
    WHERE kv_entries.expires_at IS NOT NULL AND kv_entries.expires_at <= ?
    ```
  - It returns `result.changes > 0`.
  - A live row with `expires_at` NULL is never taken over, and a live row with a future `expires_at` is not taken either.
  - The lease TTL must therefore be set through `expiresAt`.
- `deleteKv(namespace, key): Promise<boolean>` at line 14081.
  - It does not check ownership or a token. A token compare must be done by the caller, with `getKv`, then `deleteKv`, inside a transaction.
- All four call `getDbClient().get` or `.run` and never take a `tx` argument. `src/be/db-client.ts:181` defines `txContext = new AsyncLocalStorage<TxContext>()`.
  - Per the CLAUDE.md async-seam rule, client-level calls inside a `transaction(async (tx) => ...)` callback join the transaction automatically.
  - They can therefore be called inside `getDbClient().transaction(...)`.
- Precedent for in-transaction KV work: `incrKv` (line 14104) opens `getDbClient().transaction(async (tx) => ...)` and uses `tx.get` directly rather than the helpers.
- `transaction` takes the write lock at BEGIN (`BEGIN IMMEDIATE`).
- `isInTransaction()` is exported at `db-client.ts:183`.
- `getKv`'s expired-row `DELETE` also joins the transaction.
- Post-commit hooks must use `getDbClient().afterCommit`.

#### Gaps
- Not read: `src/kv-overflow.ts` (`mcpOverflowAuthError`) as the shape precedent. Not read: `kv-write-auth.ts` in full. Not read: `listKv` / `countKv` signatures.
- Not read: how `requestInfo.agentId` is derived for MCP, or whether `session_tokens` callers can reach `/api/kv` with a token-derived agent id rather than only `x-agent-id`.
- No existing "may agent X run script Y" function. The rule has to be defined in the plan.
- No per-key guard exists inside a namespace besides `reservedRoomKeyError`. `state/<id>` and `lease/<id>` share one namespace, so a lease row is readable by anyone who may read the namespace.
- The `claimKv` TTL semantics (NULL `expiresAt` means a permanent claim) are exact, but a lease-renewal API does not exist. `upsertKv` would be needed for that, and it has no token check.
- Not checked: whether `check-sdk-tool-registration` or the e2e coverage manifest needs an entry for a changed `script_run` input schema.

## provenance-migrations

#### 1. session_tokens schema
- `src/be/migrations/149_session_tokens.sql:11` creates it (`id, tokenHash, tokenPreview, agentId, taskId NOT NULL, expiresAt, revokedAt, createdAt, lastUsedAt`).
- `207_runtime_session_tokens.sql:2` and `232_agent_session_tokens.sql:6` rebuild it (`CREATE TABLE session_tokens_new`, drop, rename). 232 is the latest rebuild and has:
  `id, tokenHash, tokenPreview, agentId, taskId, runtimeId, parentRuntimeId, controllerId, parentTokenId, expiresAt, revokedAt, createdAt, lastUsedAt`
- 232 also adds a 4-way `CHECK` on the binding shape (task / runtime / controller / all-null). The `ALTER ... ADD COLUMN` columns below do not touch it.
- `233_script_run_session_tokens.sql:8`: `ALTER TABLE session_tokens ADD COLUMN scriptRun INTEGER NOT NULL DEFAULT 0;`
- `293_savings_component_links.sql:12-13`: `ADD COLUMN sourceStepId TEXT;` and `ADD COLUMN sourceScriptRunId TEXT;`
- Precedent for new provenance columns (`objectChain` / `depth`): plain `ALTER TABLE ... ADD COLUMN` in a new migration. There is no `CHECK` interplay and no table rebuild.

#### 2. mintScriptRunToken and token resolution
- `src/be/users.ts:746`:
  ```ts
  export async function mintScriptRunToken(agentId: string, ttlMs: number,
    provenance: { sourceStepId?: string; sourceScriptRunId?: string } = {}): Promise<{ tokenId: string; plaintext: string }>
  ```
- It calls `insertSessionToken(agentId, null, null, ttlMs, null, undefined, null, null, true)` (users.ts:751-761). `insertSessionToken` is at users.ts:782 and takes positional args ending in `scriptRun = false`. Its INSERT at 802-820 lists columns explicitly and does not write the provenance columns.
- Provenance is then written by a separate `UPDATE session_tokens SET sourceStepId = ?, sourceScriptRunId = ? WHERE id = ?` (users.ts:764-769). It runs only if one of the two values is set.
- Production caller: `src/be/scripts/run-credential.ts:61`, in `acquireScriptApiCredential`. Test callers: scripts-http.test.ts:725, script-run-config-scope.test.ts, agent-history.test.ts:289, session-cost-attribution.test.ts:588, savings-compound.test.ts:510/514.
- `isScriptRunToken` at users.ts:774 reads `scriptRun`.
- Resolution is at users.ts:1066-1119. It selects `s.sourceStepId, s.sourceScriptRunId` (1078-1079) and returns the following:
  ```ts
  ...(row.sourceStepId || row.sourceScriptRunId
    ? { sourceStepId: row.sourceStepId, sourceScriptRunId: row.sourceScriptRunId } : {}),
  ```
  Return shape: `{kind:"agent", tokenId, tokenKind, agentId, taskId, runtimeId, expiresAt, sourceStepId?, sourceScriptRunId?}`. The shape is declared inline at users.ts:1050-1059.
- `src/utils/request-auth-context.ts:30-31` declares the same two optional fields on the `kind: "agent"` variant of `HttpRequestAuth`.
- `getCurrentRunProvenance()` (request-auth-context.ts:116) returns `RunProvenance | null`. The type is `{ sourceStepId: string | null; sourceScriptRunId: string | null }` (line 108). It returns null unless auth is `kind: "agent"` and one of the two fields is truthy. It reads the AsyncLocalStorage slot (`authStorage`).
- Adding `objectChain` / `depth` means touching four places: the type at users.ts:1050, the SELECT and return at users.ts:1078 and 1116, `HttpRequestAuth` at request-auth-context.ts:30, and `RunProvenance` at 108.

#### 3. Nested run in src/http/scripts.ts
- `scripts.ts:818` sets `const runId = crypto.randomUUID();`. Line 819 sets `const callerProvenance = getCurrentRunProvenance();`.
- It calls `runScriptWithRunCredential({...input}, { sourceScriptRunId: runId, sourceStepId: callerProvenance?.sourceStepId ?? undefined })` (scripts.ts:820-840).
- The nested run inherits only `sourceStepId` from the caller. `sourceScriptRunId` is always the new run's own id.
- `run-credential.ts:44`: `export type ScriptRunProvenance = { sourceStepId?: string; sourceScriptRunId?: string };`
- `runScriptWithRunCredential(input, provenance = {})` is at run-credential.ts:81. It calls `acquireScriptApiCredential(agentId, provenance)`, which returns early with no token (`apiKey: undefined`) when `getAgentById` finds no agent (line 58). So sentinel-id runs get no provenance.
- `ScriptRunProvenance` and `mintScriptRunToken`'s inline provenance type are two separate, identical declarations.

#### 4. script_runs table
- `083_script_workflows.sql:3`: `id, agentId, scriptName, source NOT NULL, args, status (CHECK), pid, startedAt, finishedAt, output, error, last_heartbeat_at, idempotencyKey UNIQUE, requestedByUserId, created_by, updated_by`.
- `085`: `kind TEXT NOT NULL DEFAULT 'workflow' CHECK(kind IN ('workflow','inline'))`.
- `088`: indexes only. `254`: index on `(scriptName, startedAt)`.
- `102:31`: `apiEndpointId TEXT`.
- `266`: `sourceTaskId TEXT`, `followUpGuard TEXT`.
- `293:18-19`: `sourceStepId TEXT`, `parentScriptRunId TEXT`, with partial indexes.
- `319`: indexes on `created_by`, `requestedByUserId` and `updated_by`.
- `342:8`: `sourceHash TEXT REFERENCES script_run_sources(hash)`. It also adds the `script_run_sources` table and a delete trigger.
- `recordInlineScriptRun` is at `db.ts:14435`. Its data param is `{id, agentId, source, args, scriptName?, status: "completed"|"failed", output?, error?: ScrubbedText, startedAt, finishedAt, requestedByUserId?, createdBy?, apiEndpointId?}`.
- Its INSERT columns, at db.ts:14460-14464:
  ```sql
  (id, agentId, scriptName, source, sourceHash, args, kind, status, output, error,
   startedAt, finishedAt, requestedByUserId, created_by, updated_by, apiEndpointId,
   sourceStepId, parentScriptRunId)
  VALUES (?, ?, ?, '', ?, ?, 'inline', ...)
  ```
  The values are `provenance?.sourceStepId` and `provenance?.sourceScriptRunId`, read ambiently from `getCurrentRunProvenance()` at 14455. So `parentScriptRunId` is the calling run's id.
- It runs in `client.transaction` (14457), with `storeScriptRunSource` for the source hash.
- `ScriptRunSchema` is at `src/types.ts:3774`. Its fields are `id, agentId, scriptName?, source, args, kind (workflow|inline), status, pid?, startedAt, finishedAt?, output?, error?, lastHeartbeatAt?, idempotencyKey?, requestedByUserId?, sourceTaskId?`. It carries `.openapi("ScriptRun")`.
- The schema does not expose `sourceStepId`, `parentScriptRunId`, `apiEndpointId` or `sourceHash`. `ScriptRunListItemSchema` (3797) derives from it via `.omit`. Rows are mapped by `rowToScriptRun` and `ScriptRunRow` in db.ts (not read in detail). `createScriptRun` is just above 14420.

#### 5. Migration numbering and open PRs
- The highest migration on this branch is `342_script_run_sources.sql`. The glob for 343 and above is empty, so the next free number on this branch is 343.
- Key checks in `scripts/check-migration-conflicts.sh`:
  - Duplicate prefix across the tree (lines 49-81).
  - Immutability against `origin/main` (lines 96-125).
  - Monotonicity (lines 157-159): `if [ "$prefix" -le "$BASE_MAX" ]; then NEW_VIOLATIONS=...`. This applies to files added since the merge-base.
  - The base ref defaults to `origin/main`, overridden by `MIGRATION_BASE_REF`.
- `gh` could not be run. This session has only Read, Grep and Glob, with no shell. Open-PR migration claims are therefore unchecked.

#### Gaps
- Open PR migration claims: unknown. Run `gh pr list --repo desplega-ai/agent-swarm --state open --json number,title,files --limit 50` and filter for `src/be/migrations`. Also check `origin/main`'s tail, since this branch may be stale.
- I did not read `rowToScriptRun`, `ScriptRunRow` or `SCRIPT_RUN_SELECT` in db.ts, so I cannot say whether new `script_runs` columns need a select change.
- I did not read the 207 rebuild's column list. 232 is the final rebuild, so it is the authoritative base.
- The durable-object depth and re-entry cap has no existing precedent in the provenance code. The nearest pattern is `callerProvenance` inheritance at scripts.ts:819-839.
- Open design question: should `objectChain` / `depth` ride on the `mintScriptRunToken` provenance param and the `UPDATE` at users.ts:765? Or on a new positional arg of `insertSessionToken`? Both are viable.
- Whether `ScriptRunSchema` needs new fields is undetermined. The existing provenance columns are not exposed there.

## e2e-docs

#### 1. Scenario authoring (`scripts/e2e/README.md`)
- Run: `bun run e2e --only <name>,<name>` (README:20); `--list`, `--keep`, `--shard i/4`, `--strict` also exist (README:14-24). Type check: `bun run e2e:tsc` (README:23). Boundary: `bash scripts/check-e2e-boundary.sh`.
- Skeleton (README:59-76): `import { asRecord, asRecords, expect, expectStatus } from "../http"; import type { Scenario } from "../run";` then `export const x: Scenario = { name: "kebab", order: N, async run(ctx) {...} }`. Optional `needs: ["name"]` (lower `order` required, README:102-105).
- Rules (README:78-105): black box only (no `src/` imports); seed through the API, `ctx.db` is read-only (`ctx.db.get<T>(sql, params)`); `ctx.nonce` in every name; `pollUntil` for waits; a scenario must pass alone or declare `needs`.
- Context (README:157-172): `ctx.api(method, path, { body, agentId, apiKey })` returns `{ status, json, text, headers }`. `ctx.connectMcp(agentId)` gives `callTool`. `ctx.restartSut({ env })` is the durability hook (README:169). `ctx.sutLog()` exists.
- Order band 400-499 is scripts (README:136). `script-*` orders in use: 400, 410, 420, 421, 430, 440, 445, 450, 460, 470, 480, 485, 487, 489. Free: 490-499, 401-409, 411-419.
- Agents with UUID ids: `registerAgent(ctx, label)` and `getLead(ctx)` in `scenarios/script-helpers.ts:8,28`. Other helpers: `runScript` (:37), `expectRunOk` (:49), `callToolOk/Err` (:69,:80), `structured` (:91), `withMcp` (:96), `upsertScript` (:110), `findScriptId` (:132), `startStub` (:178).
- Real prefix quote (`script-kv.ts:26-27`): `const agentId = await registerAgent(ctx, "kv"); const otherId = await registerAgent(ctx, "kv-other");`

script-* scenarios:
- `script-inline-run` (400): inline `script_run` and memory alias.
- `script-saved-lifecycle` (410): upsert, scope rules, global-vs-agent, tool errors.
- `script-sdk-calls` (420): `ctx.swarm.*` calls.
- `script-memory-rate` (421): memory rating via scripts.
- `script-limits` (430): limits and bad executor.
- `script-runs-durable` (440): `launch-script-run` journaled runs.
- `script-run-storage` (445): run storage.
- `script-connections` (450): connections.
- `script-kv` (460): KV surface, namespaces, TTL, overflow spill.
- `script-apis` (470): scripts exposed as APIs.
- `script-credential-bindings` (480).
- `script-retry-helper` (485), `script-retry-fetch` (487), `script-retry-bridge` (489).

#### 2. `coverage-manifest.json`
- Route and tool coverage comes from the live universe (`/openapi.json`, `tools/list`). The manifest holds only exclusions: `"routes": []`, `"mcpTools": []`, `"nodeTypes": []` (lines 93-95, all empty).
- A new FIELD on an existing route or tool needs no manifest change. A new route or tool needs a scenario that calls it, or an exclusion with a reason.
- `engines[0]` `script-engine` (lines 4-33): `routeGroups` include `scripts`, `script-runs`, `kv`, `internal`; `tools` include `"script-*"`, `"kv-*"`; `stateSurfaces` list `script-run-statuses`, `script-scopes`, `script-executors`, etc. Strict needs 100% per engine.
- `stateSurfaces` (114+): each is a `SELECT ... AS value` plus a declared `universe`. A new column or enum value that needs coverage means a new surface entry. Example (:203): `script-scopes` queries `SELECT DISTINCT scope AS value FROM scripts`, universe `["global","agent"]`.
- `flows` (226+): every scenario must belong to a flow. A new scenario file needs an entry, e.g. `"kv": { description, scenarios: ["script-kv"] }` (:365-368). Entries exist for `script-apis` and `script-connections` (:449+).

#### 3. `scripts/e2e/scope.ts`
- `src/scripts-runtime/*` is not mapped. The branch chain (scope.ts:199-239) handles only: scenario files, scenario helpers, `src/http/<leaf>.ts`, `src/tools/**`, skill sources, and `src/workflows/executors/*`. Anything else hits `plan = { kind: "full", reason: \`${path} has no scenario map\` }` (:238).
- `src/be/`, `src/types.ts` and `src/scripts-runtime/` therefore give a full E2E run (header comment :23-25).
- `src/tools/script-*.ts` selects scenarios whose text quotes the tool name (`toolPatterns`, :84-88). `src/http/scripts.ts` selects scenarios naming `/api/scripts` (`routePatterns`, :75-82), but only if it is a leaf (`leafSource`, :181-197).
- `src/tests/**`, `*.md` under `scripts/e2e/` and `coverage-manifest.json` are in `NOT_LOADED` (:44-45).
- `templates/skills/` maps to skills scenarios only (`SKILL_SOURCES`, :47, :221).

#### 4. swarm-scripts skill
- Dir `templates/skills/swarm-scripts/`: `config.json`, `content.md`, generated `SKILL.md`.
- `content.md` headings: `# Swarm Scripts`; `## When to script` (5), `## Loading the tools` (23), `## Seed catalog` (29), `## Authoring contract` (46), `### Upserting a large source` (76), `### What \`ctx\` holds` (89), `### Files and shell` (100), `### Durable workflow scripts` (117), `## Inline script pattern` (124), `## Named script pattern` (140), `## Secrets` (144), `## \`db_query\` for aggregation` (160), `### Concurrency limit` (180), `### Response traps` (184), `## Progress from a script` (200), `## Exposing a script as an API` (209).
- The nearest insertion points for a durable-object section are after `### Durable workflow scripts` (:117-122) or `### What ctx holds` (:89; `ctx.caller` would go here).
- Commands (package.json:78-84): `bun run build:skill-md`, `bun run check:skill-md`, `bun run build:seed-skill-files`, `bun run check:seed-skill-files`, `bun run check:skill-sources`. `check.sh:152-155` runs `build:skill-md && build:seed-skill-files` and fails on drift. `bundled-files.generated.json` is only needed if `files/` changed.

#### 5. `check:local` (`scripts/check.sh`)
1. `bun install --frozen-lockfile` (:103)
2. `bunx biome check` on changed files within `^(src/|apps/evals/|apps/ui/|packages/ui-e2e/|packages/model-routing/)` (:40, :117-124)
3. `bun run lint:slop` (:127)
4. `bun run tsc:check` (`bun check`) (:130), plus `bun check -b` in `apps/ui` when it changed
5. Drift steps, each only when its trigger regex matches the touched files (:140-159):
   - script SDK types: `build:script-types && build:extension-types`. Triggers on `src/scripts-runtime/`, `src/be/scripts/`, `src/tools/`, `src/types.ts`.
   - openapi: `docs:openapi`.
   - pi-skills.
   - seeded skills: `build:skill-md && build:seed-skill-files`.
   - extension catalog and schema.
6. `PRE_PUSH_TESTS_INCLUDE_WORKTREE=1 bash scripts/pre-push-tests.sh` (:162)
7. E2E scoped via `scope.ts`: `skip`, `full` (4 parallel shards) or `only <names>`. `--skip-e2e` skips it (:164-201).

Check commands:
- Biome (read-only, CI): `bun run lint` is `biome check src apps/evals packages/ui-e2e packages/model-routing packages/model-catalog` (package.json:158). `lint:fix` adds `--write`.
- `bun run tsc:check:tsc` is `bun tsc --noEmit` (:122).
- `bun scripts/check-floating-promises.ts` and `bun scripts/check-promise-sinks.ts` have no package.json scripts. `merge-gate.yml:437-453` runs them directly.
- `bun run check:rbac-coverage` is `bun scripts/check-rbac-coverage.ts` (:129).
- `bun run check:openapi-response-coverage` is `bun scripts/check-openapi-response-coverage.ts` (:131).
- `bun scripts/check-sdk-tool-registration.ts` (merge-gate.yml:525). It was not found in the package.json grep, so there is no npm alias.
- `script-run` is registered via `createToolRegistrar` at `src/tools/script-run.ts:49-50`. `SDK_TOOL_NAME_MAP` maps `script_run` to `"script-run"` (`src/scripts-runtime/sdk-allowlist.ts:76`).

#### Gaps
- Not read: `scripts/check-sdk-tool-registration.ts`, `check-floating-promises.ts` and `check-promise-sinks.ts` internals. Not confirmed whether the first checks `script_run` input schema fields or only tool names.
- `scripts/pre-push-tests.sh` scoping not read.
- Whether `session_tokens` `objectChain`/`depth` columns need a `stateSurfaces` entry is undecided. The existing surfaces only cover `scripts` and run tables.
- A new `script-durable-objects` scenario needs a free `order` (490-499 is free), a `flows` entry, and either route-group or tool-name quotes so `scope.ts` can select it.
- `SKILL.md` is generated (`build:skill-md`). I did not check its exact frontmatter or `config.json` fields.
