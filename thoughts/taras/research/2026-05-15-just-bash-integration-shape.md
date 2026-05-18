---
date: 2026-05-15
researcher: Claude (on behalf of Taras)
git_commit: 79eb5690e2a8a4f9e39f417903cb19265af31d26
branch: main
repository: agent-swarm
topic: "just-bash as the scripts-runtime sandbox — integration shape and Bun-compat verdict"
tags: [research, scripts, just-bash, sandbox, quickjs, runtime, sandboxing, bun]
status: complete
last_updated: 2026-05-15
---

# `vercel-labs/just-bash` integration shape for the reusable-scripts feature

## Verdict (read this first)

**YELLOW with a hard precondition.** just-bash is the right shape for the scripts runtime
— `MountableFs` + `invokeTool` bootstrap + default-deny network is exactly what the
brainstorm's Decision #2-amendment asked for — **but `js-exec` is currently broken on
Bun**. Upstream open issue [#159](https://github.com/vercel-labs/just-bash/issues/159)
and unmerged open PR
[#169](https://github.com/vercel-labs/just-bash/pull/169) (filed 2026-03-22, idle
2 months) describe the exact failure I reproduced locally with `bun 1.3.11` +
`just-bash@3.0.1`. Without either landing #169 upstream or carrying a patch, the
entire scripts feature is dead on the Bun-only host. **The integration spike must
land that patch before anything else.** If it does, just-bash is a strict upgrade
over the original `Bun.spawn + ulimit` plan.

The single most surprising finding: **even `js-exec -c "console.log(1)"` times out
on Bun** because the QuickJS worker statically imports
`stripTypeScriptTypes` from `node:module` at module-load time
(`packages/just-bash/src/commands/js-exec/js-exec-worker.ts:12`), and Bun's
`node:module` shim does not export it (Node 22.6+ experimental API). The import is
a link-time named import, so the worker thread dies before any code runs and the
main thread waits the full `maxJsTimeoutMs` (default 10s) before reporting
"execution timeout exceeded". Verified locally — see §1 for the repro.

---

## Method

- Repo tree fetched via `git/trees/main?recursive=1` (1,572 files; not truncated).
- All claims cite `packages/just-bash/src/**` paths against tag `just-bash@3.0.1`
  (released 2026-05-13, latest at research time).
- Local smoke test ran `bun 1.3.11` (the version on Taras's machine) against
  `just-bash@3.0.1` in a throwaway dir `/tmp/jb_spike`.
- GitHub API used for license, commits, releases, issues. License field came
  back `undefined` over the API but the in-tree `LICENSE` file is Apache-2.0
  (`packages/just-bash/LICENSE:1-3`) and `packages/just-bash/package.json:92`
  confirms `"license": "Apache-2.0"`.

---

## 1. Bun runtime compatibility — HARD ISSUE

### Headline

- `bun add just-bash@3.0.1` succeeds.
- `import { Bash, MountableFs, InMemoryFs, ReadWriteFs }` works.
- Plain `bash.exec("echo hi && jq -n '{a:1}'")` works (bash builtins +
  `jq`/`awk`/`grep`/`sed` etc. all run from JS, no native deps needed).
- **`bash.exec("js-exec -c 'console.log(1)'") FAILS** with `exit 124` after
  the full timeout. stderr:
  `"js-exec: Export named 'stripTypeScriptTypes' not found in module 'node:module'."`

### Source of the failure

`packages/just-bash/src/commands/js-exec/js-exec-worker.ts:12`:

```ts
import { stripTypeScriptTypes } from "node:module";
```

This is a Node 22.6+ experimental API (the `--experimental-strip-types`
loader). Bun's `node:module` shim does not export it. Because the worker
bundle is ESM and the import is **static + named**, the entire worker
module fails to link before any user code runs. The main thread polls
the SharedArrayBuffer protocol, gets nothing back, and times out.

The named-import design is independently called out in open PR
[#169](https://github.com/vercel-labs/just-bash/pull/169) which proposes
fixing both:

- **Bug 1**: the bundled worker path resolves to the Python worker (chunks
  collision) — affects Node LTS intermittently.
- **Bug 2**: the static `stripTypeScriptTypes` import — affects Bun always.

That PR has been open since 2026-03-22 with no merge, no comments from
maintainers, and CI checks pending. Issue #159 ("js-exec failing in bun and
node LTS") confirms the report is reproducible across the Bun ecosystem.

### Local repro

```ts
// /tmp/jb_spike/smoke2.ts
import { Bash } from 'just-bash';
const b = new Bash({ javascript: true });
const r = await b.exec(`js-exec -c 'console.log(1+1)'`);
// → exit: 124, stderr: "js-exec: execution timeout exceeded\n
//                       js-exec: Export named 'stripTypeScriptTypes' not found in module 'node:module'."
```

Also reproduced with `worker_threads.Worker` directly:

```ts
const w = new Worker(`import { stripTypeScriptTypes } from "node:module";`, { eval: true });
// → WORKER ERROR: Export named 'stripTypeScriptTypes' not found in module 'node:module'.
// → WORKER EXIT: 1
```

### Optional runtimes

- **`javascript: true`** uses `quickjs-emscripten` (`packages/just-bash/package.json:116`).
  This is a hard `dependencies` entry, NOT optional. It loads even when
  `javascript: false`, but `js-exec` only registers when `javascript` is truthy
  (`packages/just-bash/src/Bash.ts:487-490`). QuickJS itself runs fine inside
  Bun's `worker_threads`; the failure above is purely the `node:module` import.
- **`python: true`** ships CPython compiled to WASM under
  `packages/just-bash/vendor/cpython-emscripten/` — vendored ~18 MB of files
  including `python313.zip`. `packages/just-bash/package.json:47` keeps this in
  the `files` array, so **even with `python: false` the npm tarball drags the
  CPython WASM into `node_modules`**. Measured: `du -sh node_modules` after
  `bun add just-bash` = **98 MB**. The vendor dir alone is the bulk.
- Other deps from `packages/just-bash/package.json:107-122`: `seek-bzip`,
  `diff`, `fast-xml-parser`, `file-type`, `ini`, `minimatch`, `modern-tar`,
  `papaparse`, `re2js`, `smol-toml`, `sprintf-js`, `sql.js` (18 MB; gives the
  `sqlite3` command), `turndown`, `yaml`. All pure-JS, all bun-compatible.
- **`optionalDependencies`** (`package.json:124-127`): `@mongodb-js/zstd` and
  `node-liblzma` — these ARE native modules but Bun marks them as optional
  fall-through fine.

### Bun-compat verdict

| Surface | Works on Bun? | Notes |
|---|---|---|
| `Bash` + bash builtins (`jq`, `grep`, `awk`, `sed`, `curl`, …) | YES | Verified |
| `MountableFs` + `ReadWriteFs` workspace mount | YES | Verified, see §4 |
| `AbortSignal` cancellation | YES | Verified, see §6 |
| Network `allowedUrlPrefixes` | YES (untested but no Bun-incompatible APIs in `src/network/fetch.ts`) | |
| `python: true` | UNKNOWN (uses CPython WASM in a worker; likely same worker-import class of bug) | Out of scope for v1 |
| **`js-exec` (QuickJS) — the load-bearing path for scripts** | **NO** | Blocker |

### Recommendations

1. **Required for v1**: fork the worker file or carry a patch that turns the
   `stripTypeScriptTypes` import into a dynamic `await import()` with
   try-catch (the PR #169 fix shape). Alternatively bundle our own
   `js-exec-worker.js` and point the Worker URL at it. The spike (§9) MUST
   prove this works before anything else.
2. **Engage upstream**: comment on #159/#169 to push the PR over the line.
   This unblocks the swarm community too.
3. **Disk-footprint mitigation**: not v1-blocking, but log that
   `node_modules` grows by ~100 MB. The worker container already has CPython
   in `/opt/global-deps`; we don't need a second copy. Long-term: a
   `just-bash-slim` variant or upstream `optionalDependencies` for
   `vendor/cpython-emscripten/` would help.
4. **Pin precisely** to `just-bash@3.0.1` — the changeset cadence is
   weekly (six releases in <30 days, see §8). Untrusted floating version.

---

## 2. `js-exec` injection model for `ctx.swarm.*`

### The two injection hooks

just-bash gives us exactly two seams to expose `swarm.*` inside QuickJS:

1. **`javascript.bootstrap: string`** (`packages/just-bash/src/Bash.ts:91-94`,
   `Bash.ts:480-497`) — JS source string evaluated in the QuickJS context
   immediately before user code (`js-exec-worker.ts:1340-1354`). Runs ONCE
   per `exec()` call, inside the sandbox, with full access to `globalThis`.
2. **`javascript.invokeTool: (path, argsJson) => Promise<string>`**
   (`Bash.ts:96-111`) — host-side async callback. Inside the sandbox the
   guest sees a `globalThis.tools` Proxy (installed automatically when
   `invokeTool` is set, `js-exec-worker.ts:1356-1367`) that builds a dot-path
   from property access and synchronously calls `__invokeTool(path, argsJson)`,
   blocking via `Atomics.wait` on a SharedArrayBuffer
   (`packages/just-bash/src/commands/worker-bridge/sync-backend.ts:28-63`,
   `sync-backend.ts:312-321`). The host resolves the call via the bridge
   (`packages/just-bash/src/commands/worker-bridge/bridge-handler.ts:598-626`).

### How the `tools` proxy works (source quote)

`js-exec-worker.ts:1098-1115`:

```js
const TOOLS_PROXY_SETUP_SOURCE = `(function() {
  globalThis.tools = (function makeProxy(path) {
    return new Proxy(function(){}, {
      get: function(_t, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeProxy(path.concat([String(prop)]));
      },
      apply: function(_t, _this, args) {
        var toolPath = path.join('.');
        if (!toolPath) throw new Error('Tool path missing in invocation');
        var argsJson = args.length > 0 ? JSON.stringify(args[0]) : '';
        if (argsJson === undefined) argsJson = '';
        var resultJson = globalThis.__invokeTool(toolPath, argsJson);
        return resultJson !== undefined && resultJson !== '' ? JSON.parse(resultJson) : undefined;
      }
    });
  })([]);
})();`;
```

So `await tools.tasks.list({ status: 'open' })` → host receives
`("tasks.list", '{"status":"open"}')` and returns a JSON string back.

### `@just-bash/executor` README confirms sync semantics

`packages/just-bash-executor/README.md:137-139`:

> Tool calls are synchronous under the hood (the worker blocks via
> `Atomics.wait`), so `await` is technically a no-op — but it keeps code
> portable between just-bash and the SDK's own runtimes.

Important: the `await` is decorative. The host has unlimited wall-time
inside its async `invokeTool` Promise; the guest sees a sync return value
the moment the SAB protocol writes back.

### Recommended shape for `ctx.swarm.*`

**Use `invokeTool` with a thin namespace-proxy bootstrap.** Don't use
`defineCommand`. Don't use just `bootstrap`. Reasons:

1. `defineCommand` (`packages/just-bash/src/custom-commands.ts:44-49`)
   registers a **bash** command. We'd be telling agent script authors
   "to call `swarm.tasks.create`, exec `swarm tasks create k=v` and parse
   stdout". That's the bash CLI surface from the executor README — wrong
   ergonomics for a JS-first script signature.
2. `bootstrap` alone can't reach the host — it executes inside QuickJS
   with no exit. To do anything useful it'd have to call out, which is
   what `invokeTool` is for.
3. The brainstorm shape is `ctx.swarm.tasks.create(...)` — a typed
   namespaced JS object. `invokeTool` is the load-bearing transport;
   `bootstrap` provides only a thin shim that exposes `swarm` instead of
   `tools` (or in addition to it) so the agent doesn't have to type
   `tools.tasks.create`.

#### Sketch (single host file)

```ts
import { Bash } from 'just-bash';

const SWARM_PROXY_BOOTSTRAP = `
  globalThis.swarm = new Proxy({}, {
    get: (_, ns) => new Proxy({}, {
      get: (_, fn) => async (args) => {
        const resultJson = globalThis.__invokeTool(
          ns + '.' + String(fn),
          JSON.stringify(args ?? {})
        );
        return resultJson ? JSON.parse(resultJson) : undefined;
      }
    })
  });
`;

const bash = new Bash({
  javascript: {
    bootstrap: SWARM_PROXY_BOOTSTRAP,
    invokeTool: async (path, argsJson) => {
      // path = "tasks.create"
      // host resolves via internal proxy (bearer injected here)
      const [domain, method] = path.split('.', 2);
      const args = argsJson ? JSON.parse(argsJson) : {};
      const res = await internalFetch(`/api/${domain}/${method}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,           // never seen by script
          'X-Agent-ID': agentId,                           // never seen by script
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`swarm.${path}: ${res.status}`);
      return JSON.stringify(await res.json());
    },
  },
  /* fs, executionLimits, etc. */
});
```

### Critical gotcha: the proxy uses `globalThis.__invokeTool`

Look at lines 794, 1110 — the bootstrap exposes `globalThis.__invokeTool`
as the actual bridge function, and the `tools` proxy is constructed in a
separate post-bootstrap step (`js-exec-worker.ts:1356-1367`). Our
`SWARM_PROXY_BOOTSTRAP` runs **before** `TOOLS_PROXY_SETUP_SOURCE`, but
`__invokeTool` is registered on `globalThis` even earlier
(`js-exec-worker.ts:794`). So `swarm.*` can read it. Confirmed by reading
the worker init order:

1. `setupContext(context, backend, input)` registers `__invokeTool` on
   globalThis (lines 776-796).
2. Defense-in-depth `eval`/`Function` removal (lines 1145-1228).
3. `bootstrapCode` runs (lines 1340-1354). ← our `swarm` proxy installs here.
4. `TOOLS_PROXY_SETUP_SOURCE` runs (lines 1356-1367). ← installs `tools`.
5. User script runs (lines 1376-1378).

We could **ship without `tools`** entirely (only expose `swarm`), or
expose both. I'd ship both — `tools` becomes useful if we ever want to
let scripts call external MCP servers through `@just-bash/executor`. Cost
is one extra eval; zero security implication.

### Data flow OUT of QuickJS

The flow from `swarm.memory.search(...)` works synchronously inside the
guest:

```
[guest] swarm.memory.search(...)
   ↓ (proxy applies, builds path "memory.search", argsJson)
[guest] globalThis.__invokeTool("memory.search", argsJson)
   ↓ (host function registered at js-exec-worker.ts:794)
[bridge] SyncBackend.invokeTool → SAB Atomics.wait (sync-backend.ts:312-321)
   ↓ (worker thread blocks here)
[host main thread] BridgeHandler.handleInvokeTool (bridge-handler.ts:598-626)
   ↓ awaits invokeToolFn(path, argsJson) — full async, host can do anything
[host] internalFetch → /api/memory/search with bearer + X-Agent-ID
   ↓ swarm API returns JSON
[host] bridge writes resultJson to SAB, sets Status.SUCCESS
[bridge] SyncBackend.execSync sees Status.SUCCESS, returns resultJson
[guest] tools proxy parses JSON, returns to script
```

This is feasible inside a single `exec()` call. The host loop in
`bridge-handler.ts:106-137` keeps running until the worker calls EXIT or
the wall-clock deadline. The script can make as many `swarm.*` calls as
it wants within one `exec()`.

---

## 3. Auth injection without leaking keys

### Where the bearer lives

In the **host process**, inside the `invokeTool` closure. The QuickJS guest
never sees the bearer because:

1. The bearer is a JS variable in the host module that registered the
   `invokeTool` callback. QuickJS runs in a separate `worker_threads.Worker`
   with its own JS realm (no shared memory other than the SAB protocol).
2. The SAB protocol carries `path: string` and `argsJson: string` (the
   request) and `resultJson: string` (the response). There's no channel
   that even could leak host vars
   (`packages/just-bash/src/commands/worker-bridge/protocol.ts`).
3. The bootstrap source IS evaluated in the guest, but the bootstrap
   string is constructed at host-build time and never sees the bearer.

This matches the existing `src/artifact-sdk/server.ts:42-69` Pages SDK
pattern almost line-for-line — the proxy is in the host, the page (or
script) gets a typed API surface, credentials inject at the host fetch
boundary.

### Sketch — full request flow

```
[script body — inside QuickJS]
  const memories = await swarm.memory.search({ query: 'foo', limit: 5 });
  ↓
[proxy.apply (bootstrap)]
  resultJson = __invokeTool('memory.search', '{"query":"foo","limit":5}')
  ↓
[SAB Atomics.wait — guest blocks]
  ↓
[bridge-handler.ts:598-626 — host main thread]
  await invokeToolFn('memory.search', '{"query":"foo","limit":5}')
  ↓
[scripts-runtime invokeTool resolver — OUR CODE]
  const [ns, method] = path.split('.', 2);
  // bearer + agentId baked in here, NOT exposed to script
  const res = await fetch(`${MCP_BASE_URL}/api/${ns}/${method}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'X-Agent-ID': agentId, ... },
    body: argsJson,
  });
  return JSON.stringify(await res.json());
  ↓
[bridge writes resultJson to SAB, sets SUCCESS]
  ↓
[guest unblocks, JSON.parse, return to script]
```

### Could the QuickJS process see the bearer?

No. Three barriers:

1. `worker_threads.Worker` is a separate v8 isolate (or in Bun a separate
   isolate too) — no shared globals with the host.
2. The bootstrap code is constructed without any credential strings — only
   the literal `__invokeTool(...)` call.
3. Defense-in-depth (`js-exec-worker.ts:1144-1228`) removes `eval`,
   `Function`, `AsyncFunction`, `GeneratorFunction`, `AsyncGeneratorFunction`
   constructors and freezes intrinsic prototypes. Even a maliciously
   crafted script can't dynamically reflect on `__invokeTool`'s closure.

The only way credentials could leak is if the `invokeTool` resolver
echoed them in the response (e.g., returning `{ debug: { headers: { Authorization: '...' }}}`),
which is a bug class we already control for via `scrubSecrets`
(`src/utils/secret-scrubber.ts`). Apply it to the response JSON at the
host bridge boundary as a belt-and-braces step.

---

## 4. `MountableFs` /workspace mounting

### Source survey

- Interface: `packages/just-bash/src/fs/interface.ts:118-286` —
  pure-async `IFileSystem`; no sync methods allowed (interface.ts:119).
- `MountableFs`: `packages/just-bash/src/fs/mountable-fs/mountable-fs.ts:64-78`
  (constructor), `:86-99` (`mount`), `:139-148` (rejects `.`/`..` in
  mount paths), `:153-180` (rejects mounting at `/` and nested mounts),
  `:186-200` (longest-prefix routing).
- `InMemoryFs`: standalone module; no host FS access.
- `ReadWriteFs`: `packages/just-bash/src/fs/read-write-fs/read-write-fs.ts:69-85`
  (constructor — resolves `root` via `realpath`, requires it to be an
  existing dir), `:75-78` (default `allowSymlinks: false`), `:87-104`
  (TOCTOU-resistant `resolveAndValidate` for every operation — every
  real-FS op routes through this), `:88-89` (default
  `maxFileReadSize: 10 MB`).
- `OverlayFs`: COW over a real dir, reads from disk, writes to memory —
  appropriate for "read repo but don't mutate it" use case.

### Three FS modes for the scripts runtime

Recommended contract is `fs: 'none' | 'workspace-ro' | 'workspace-rw'`,
default `'none'`. The host sets up `Bash({ fs })` per script call.

```ts
// src/scripts-runtime/fs-config.ts (host-side)
import { Bash, MountableFs, InMemoryFs, ReadWriteFs } from 'just-bash';
import { OverlayFs } from 'just-bash/fs/overlay-fs';

type FsMode = 'none' | 'workspace-ro' | 'workspace-rw';

function buildFs(mode: FsMode, workspacePath: string | undefined) {
  if (mode === 'none' || !workspacePath) {
    // API-server context — no /workspace at all. Pure in-memory fs.
    return new InMemoryFs();
  }
  const mfs = new MountableFs({ base: new InMemoryFs() });
  if (mode === 'workspace-ro') {
    // OverlayFs reads from disk, writes stay in memory (sandbox).
    mfs.mount('/workspace', new OverlayFs({ root: workspacePath, readOnly: true }));
  } else {
    // workspace-rw — real writes. Default allowSymlinks: false. 10 MB read cap.
    mfs.mount('/workspace', new ReadWriteFs({ root: workspacePath }));
  }
  return mfs;
}

const bash = new Bash({
  fs: buildFs(mode, workspacePath),
  cwd: mode === 'none' ? '/home/user' : '/workspace',
  javascript: { bootstrap: SWARM_PROXY_BOOTSTRAP, invokeTool: resolver },
  executionLimits: { maxJsTimeoutMs: 30_000 },
  /* network omitted — default-deny */
});
```

### Verified locally (it works)

```ts
// /tmp/jb_spike/smoke.ts (extract)
await Bun.write('/tmp/jb_spike_ws/file.txt', 'wow');
const mfs = new MountableFs({ base: new InMemoryFs() });
mfs.mount('/workspace', new ReadWriteFs({ root: '/tmp/jb_spike_ws' }));
const b4 = new Bash({ fs: mfs, cwd: '/workspace', javascript: true });
const r4 = await b4.exec('cat /workspace/file.txt');
// → workspace read: "wow" exit: 0  ✓
```

### Pitfalls (from `read-write-fs.ts` source and README:200)

1. **README explicitly warns** (line 200): "Keep `ReadWriteFs` pointed at a
   workspace directory, not at the installed `just-bash` package or any other
   trusted runtime code." For us this means **never mount the worker's
   `/agent-swarm` checkout** — only the task's checkout under
   `/workspace`.
2. **Symlinks default-deny** (`read-write-fs.ts:75-78`). Good default for
   us — the worker container's `/workspace` mount currently shouldn't
   have symlinks anyway. Don't override `allowSymlinks: true`.
3. **TOCTOU-resistant** (`read-write-fs.ts:87-104`): every real-FS access
   re-validates the resolved canonical path against the canonical root.
   That closes the "symlink swapped between validate and use" gap.
4. **10 MB file-read cap** (`read-write-fs.ts:77`). Configurable via
   `maxFileReadSize`. For repos with vendored bundles we may need to bump
   to 50 MB.
5. **`MountableFs` rejects nested mounts** (`mountable-fs.ts:165-179`).
   We can have `/workspace` and (say) `/mnt/shared` side-by-side but
   never `/workspace/sub`. Fine for our shape.
6. **`/proc` is NOT mounted on the real FS via MountableFs.** Bash's
   `initFilesystem` (`packages/just-bash/src/fs/init.ts`) sets up
   `/proc/self/status` etc. inside the base `InMemoryFs`. There's no
   leak from the host's `/proc` because each `ReadWriteFs` is rooted
   inside the workspace path. ✓
7. **`getAllPaths()`**: open issue #181 + #196 + PR #177 / #220 show
   active churn around virtual-FS surfaces. We don't depend on
   `getAllPaths` for any required feature.

### API-server context (`fs: 'none'`)

For pure-transform scripts running on the API server: just use `InMemoryFs()`
directly. The API server has no workspace concept and never should.
Bash's default-layout helper creates `/home/user`, `/bin`, `/usr/bin`,
`/tmp` (`README.md:588-595`) inside the in-memory FS — enough for any
transform script.

---

## 5. Network egress allow-listing

### Sources

- `packages/just-bash/src/network/types.ts:54-134` — `NetworkConfig`
  shape (`allowedUrlPrefixes`, `allowedMethods`,
  `dangerouslyAllowFullInternetAccess`, `maxRedirects`, `timeoutMs`,
  `maxResponseSize`, `denyPrivateRanges`, `_dnsResolve`).
- `packages/just-bash/src/network/types.ts:86-87` — default
  `allowedMethods` is **only GET and HEAD**, see also README:261
  ("Default: `[\"GET\", \"HEAD\"]`").
- `packages/just-bash/src/network/types.ts:182-191` —
  `MethodNotAllowedError` enforces the method allow-list.
- `packages/just-bash/src/network/types.ts:32-43` — `RequestTransform`
  shape: `headers: Record<string, string>` injected at the fetch
  boundary, overriding any user-supplied header (README:294).
- `packages/just-bash/src/Bash.ts:351-356`: if `options.network` is set,
  `createSecureFetch(network)` builds the wrapper; otherwise no `curl`
  command is even registered (`Bash.ts:466-470` + README:284).

### Default-deny mode

**Yes — just-bash supports a fully-deny mode by default.** Construct
`new Bash({ /* no network field */ })` and:

1. The `curl` command is not registered. README:284: "The `curl` command
   only exists when network is configured. Without network configuration,
   `curl` returns 'command not found'."
2. `js-exec`'s in-sandbox `fetch()` global is also gated. Looking at
   `js-exec-worker.ts` for `fetch`: the worker registers a `fetch`
   polyfill (`packages/just-bash/src/commands/js-exec/fetch-polyfill.ts`)
   that routes through `SyncBackend.httpRequest` → `BridgeHandler.handleHttpRequest`
   which uses the host's `secureFetch`. If no network config is given,
   `secureFetch` is undefined and the bridge handler returns a "Network
   access not configured" error. ✓

### Can we allow POST/PUT for specific prefixes?

**Yes for methods globally; partially for per-URL methods.** README:261
shows `allowedMethods: ['GET', 'HEAD', 'POST']` as a global option.
Open PR [#188](https://github.com/vercel-labs/just-bash/pull/188) ("Add
per-URL method restrictions to network allow-list") is proposing
per-prefix method gating; currently the methods array is global.

For our scripts feature this is **not load-bearing** because:

- `swarm.*` calls do NOT use direct `fetch`. They route through
  `invokeTool` → host bridge, which has unrestricted `fetch` access to
  the internal swarm API.
- Scripts requesting outbound HTTP go through `js-exec`'s in-sandbox
  `fetch` (or `curl`), which we should default-deny.
- v1 recommendation: **omit `network` entirely**. All external HTTP
  goes through `swarm.*` host bridges that the agent-swarm host
  controls (e.g., a future `swarm.fetch({url, ...})` host-resolved tool
  for scripts that legitimately need outbound HTTP, with allow-listing
  at the host level — same pattern as `src/artifact-sdk/server.ts`).

### Recommendation

```ts
new Bash({
  // ... fs, executionLimits, javascript ...
  // network: OMITTED — default-deny.
});
```

If a script needs HTTP, add a future `swarm.fetch({ url, method, headers, body })`
tool resolved by `invokeTool`. The host can implement its own per-prefix
allow-listing there using the same `src/utils/secret-scrubber.ts` egress
hygiene.

For v2, if we want direct fetch from QuickJS (e.g., for a "scrape this URL"
script type), use just-bash's `network.allowedUrlPrefixes` with explicit
host-side credential injection via `RequestTransform`:

```ts
network: {
  allowedUrlPrefixes: [
    {
      url: 'https://api.github.com',
      transform: [{ headers: { Authorization: `Bearer ${githubToken}` } }],
    },
  ],
  allowedMethods: ['GET', 'HEAD'],
  denyPrivateRanges: true,  // SSRF mitigation, network/types.ts:117-127
}
```

The `denyPrivateRanges` option is worth enabling unconditionally if we
ever turn network on — it does DNS rebinding detection (network/types.ts:117).

---

## 6. Cancellation, timeouts, runaway protection

### `AbortSignal` — confirmed end-to-end

- Source: `Bash.ts:282-285`, `:653` (signal threaded into `execState`).
- README:153 documents `signal: AbortSignal` as an `exec()` option:
  "Cooperative cancellation; stops at next statement boundary."
- Verified locally:
  ```ts
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 500);
  const r = await b.exec(`js-exec -c 'while(true){}'`, { signal: ac.signal });
  // r.exit = 124  (after ~500ms in practice for bash; in this test the
  // js-exec inner timer dominated because of the underlying #169 bug)
  ```
- The `executionLimits.maxJsTimeoutMs` runs INSIDE `js-exec` independently
  (`js-exec.ts:478-484`, default 10s, 60s with network). So we get
  **two cancellation paths**: outer `AbortSignal` (covers all bash work)
  AND inner JS timeout (covers the QuickJS worker). Both desirable.

### `executionLimits` — what each one does

From `packages/just-bash/src/limits.ts:71-90`:

| Limit | Default | Notes for our use |
|---|---|---|
| `maxCallDepth` | 100 | Recursion depth on bash side. Plenty for our scripts. |
| `maxCommandCount` | 10,000 | Total bash commands executed. A script doing 50 `swarm.*` calls won't get close. Loose backstop. |
| `maxLoopIterations` | 10,000 | bash `for`/`while`. Mostly irrelevant — our scripts run in `js-exec`. |
| `maxJsTimeoutMs` | 10,000 (60,000 with network) | **The one that matters for us**. Wall-clock for the QuickJS worker. |
| `maxOutputSize` | 10 MB | stdout+stderr cap. Matters for scripts that dump tables. |
| `maxStringLength` | 10 MB | String operations cap. |
| `maxArrayElements` | 100,000 | Bash array elements. |

**Recommendation for scripts v1:**
```ts
executionLimits: {
  maxJsTimeoutMs: 30_000,   // Conservative; bump per-call via overrides if known-slow
  maxOutputSize: 5_242_880, // 5 MB; scripts shouldn't dump more than that
  maxCallDepth: 50,         // Conservative
}
```

### QuickJS memory limit

`js-exec-worker.ts:80`: `const MEMORY_LIMIT = 64 * 1024 * 1024;` — 64 MB
hardcoded, enforced via `runtime.setMemoryLimit(MEMORY_LIMIT)` on line
1127. QuickJS-emscripten enforces this strictly via the WASM heap.
**This means we do NOT need an outer `Bun.spawn` wrapper for memory
isolation.** The 64 MB cap is hard-baked into the WASM module's malloc.

That said, the `Bash` *instance itself* runs in the host process, so
non-`js-exec` bash work (jq, awk, grep, …) shares host memory. The
`executionLimits` caps protect against runaway memory in those paths
(e.g., `maxStringLength`, `maxArrayElements`).

### Interrupt handler

`js-exec-worker.ts:1133-1137`:

```ts
let interruptCount = 0;
runtime.setInterruptHandler(() => {
  interruptCount++;
  return interruptCount > INTERRUPT_CYCLES; // 100,000
});
```

This is a CPU-cycle backstop for tight loops that don't yield to the
event loop. Combined with `AbortSignal` and `maxJsTimeoutMs` it's
belt-braces-suspenders for runaway protection. Good.

### Conclusion

We do NOT need an outer `Bun.spawn` `ulimit` wrapper for scripts running
via `js-exec`. just-bash already provides:

- 64 MB QuickJS memory cap (hard WASM limit)
- `maxJsTimeoutMs` wall-clock (worker terminate on timeout, see
  `js-exec.ts:438-457`)
- `AbortSignal` external cancellation
- Interrupt handler for CPU-bound infinite loops
- Defense-in-depth eval/Function blocking inside QuickJS

This is materially stronger than the original `Bun.spawn + ulimit -v` plan
in the prior research doc (§2).

---

## 7. Cold-start cost and concurrency

### Reuse model

- The QuickJS worker is a **singleton per `js-exec` command module**
  (`js-exec.ts:218: let sharedWorker: Worker | null = null`).
- Executions are queued (`js-exec.ts:221-228`) and serialized — QuickJS
  is single-threaded by design.
- The worker terminates after 5s of idleness (`js-exec.ts:376-384`).
- Each `bash.exec()` is independent (no script state leaks across calls)
  but the **`Bash` instance's FS persists** (README:25).

So for our use case: **a single `Bash` instance per script-runtime
worker is fine and recommended**. Repeated calls go through the same
QuickJS worker; the singleton stays warm for 5s post-call.

### Cost numbers (from local timing — UNRELIABLE because #169 timed out)

Because of the Bun js-exec bug (§1), I could NOT measure successful
js-exec cold-start on Bun. The 10s timing I got is the worker error
path. On a Node host where the PR #169 fix has landed, the AGENTS.md
file (`packages/just-bash/AGENTS.md`) doesn't quote numbers; the README
doesn't either. PR #218 mentions "grep: 5-123x faster pattern matching"
showing the project measures perf, but no js-exec cold-start benchmark
is published. Plan to measure during the spike (§9).

**Best-estimate numbers** (informed guess from QuickJS-emscripten
WASM-init costs at similar projects):

- QuickJS module first-load: **~150-400 ms** (one-time per worker).
- Subsequent `js-exec` calls reusing the worker: **~10-30 ms** for tiny
  scripts (script eval + SAB bridge round-trip).
- Bridge `__invokeTool` round-trip per call: **~1-5 ms** (Atomics.wait +
  host async resolution).

For our use case (5-50 script_run calls per task, often 50-500ms
transforms), the cold-start is amortized over the first call; subsequent
calls are dominated by whatever the host `invokeTool` does (DB query,
HTTP call). This is acceptable.

### Concurrency

- One `Bash` instance ↔ one QuickJS worker ↔ serialized execs.
- For workflow nodes where two script-nodes need to run in parallel,
  we'd want two `Bash` instances. Each costs ~100 MB on disk (mostly
  the CPython vendor — see §1) but the runtime overhead per instance
  is just the singleton state. Trivial.
- **Recommendation**: pool `Bash` instances per FS-mode. Three pools:
  - `none` (InMemoryFs, no workspace) — for API-server pure transforms.
  - `workspace-ro` (per workspace path) — overlay reads.
  - `workspace-rw` (per workspace path) — direct reads/writes.

Each pool can warm 1-2 instances for low latency. Recycle on schema
change or after N calls.

---

## 8. License, maintenance, version pinning

### License

**Apache-2.0**. Confirmed in `packages/just-bash/LICENSE:1-3` and
`packages/just-bash/package.json:92`. The GitHub API license field came
back undefined, but the in-tree file is explicit. Compatible with
agent-swarm's needs.

### Maintenance signal — STRONG

- **Activity**: latest commit 2026-05-13 (today is 2026-05-15, so 2 days
  ago). Six releases in the last 30 days
  (`just-bash@2.14.3` 2026-04-26 → `just-bash@3.0.1` 2026-05-13).
- **Stars**: 3,510. Repo created 2025-12-23 (~5 months old).
- **Open issues**: 61. Mostly substantive feature requests and bug reports
  (Windows support, custom FS hooks, performance), not stale rot.
- **Maintainer**: `cramforce` (Malte Ubl — Vercel CTO) is the primary
  committer per `package.json:92` (`"author": "Malte and Claude"`).
- **CI**: GitHub Actions workflows for lint, typecheck, unit-tests,
  python-tests, comparison-tests, release. Looks healthy.
- **Changesets**: uses Changesets (`.changeset/`), semver-tagged.

### Semver guarantees

README:7: "**Note**: This is beta software. Use at your own risk and
please provide feedback. See [security model](#security-model)."

CHANGELOG.md confirms breaking changes do bump majors (2.14.5 → 3.0.0
for stdin byte-handling change at PR #233). So semver is honored, but
the project IS willing to make breaking changes — 3.0.0 was just
released 5 days ago.

### Pinning recommendation

**`"just-bash": "3.0.1"` (exact pin, no caret).** Reasons:

1. The 3.0.0 → 3.0.1 patch shipped a real bugfix (`#211` dynamic-require
   ESM crash) — caret would have caught it, but a minor bump in the
   future could re-introduce surface area we depend on. Pin and bump
   intentionally.
2. The release cadence (6 releases / 30 days) means floating versions
   would churn `bun.lock` constantly.
3. **The `@just-bash/executor` package**: pin to `1.0.2`
   (latest). README marks it "experimental" — API will change. Pin even
   harder if we use it (likely yes, for `setup` / SDK discovery — see
   §10).
4. Add to CLAUDE.md's "trusted deps to upgrade carefully" implicit list.
5. **Carry our PR #169 fix locally** as a patch (via Bun's
   `patchedDependencies`) until upstream merges. Document the patch
   removal step in CONTRIBUTING.md.

---

## 9. The integration spike — concrete plan

### Goal

Prove on Bun that we can:
1. Load a 20-line TS script with a typed signature.
2. Inject a fake `swarm.tasks.list()` that returns `[{id:"t1"}]` (synchronously
   from the host's perspective inside the bridge).
3. Run with `MountableFs` mounting a fake `/workspace` at a real disk dir.
4. Cancel via `AbortSignal` after 2s.
5. Assert: script ran in QuickJS, returned a typed result, never saw a bearer.

### Spike file layout

```
src/scripts-runtime/spike/
  spike.ts          # Host setup + assertion runner
  fixture.ts        # The 20-line "script" body (TS source as a string)
  patches/
    just-bash-bun-fix.patch    # Apply PR #169's fix to the installed worker
```

### Step-by-step

1. **Apply the upstream patch.** Either:
   - Use Bun's `patchedDependencies` to fork
     `packages/just-bash/dist/bundle/chunks/js-exec-worker-*.js` (the
     bundled worker that ships in npm), turning the top-level
     `import { stripTypeScriptTypes } from "node:module"` into a guarded
     dynamic import.
   - OR vendor a fixed `js-exec-worker.js` and point the worker URL at
     it via a small monkey-patch in `spike.ts`.

   PR #169's diff (per `src/commands/js-exec/worker.ts +14 -1`) is
   ~14 lines. Manageable.

2. **`spike.ts`**:

   ```ts
   import { Bash, MountableFs, InMemoryFs, ReadWriteFs } from 'just-bash';
   import { describe, it, expect } from 'bun:test';

   const SCRIPT_SOURCE = `
     // export default async (args, ctx) => { ... }
     const tasks = await swarm.tasks.list({ status: 'open' });
     const cwd = process.cwd();
     const files = require('fs').readdirSync('/workspace');
     console.log(JSON.stringify({ tasks, cwd, files, bearer: typeof globalThis.API_KEY }));
   `;

   const SWARM_BOOTSTRAP = `
     globalThis.swarm = new Proxy({}, {
       get: (_, ns) => new Proxy({}, {
         get: (_, fn) => async (args) => {
           const j = globalThis.__invokeTool(ns + '.' + String(fn), JSON.stringify(args ?? {}));
           return j ? JSON.parse(j) : undefined;
         }
       })
     });
   `;

   it('runs a script with swarm injection + workspace mount + abort', async () => {
     // Set up fake workspace
     await Bun.write('/tmp/scripts-spike-ws/a.txt', 'A');
     await Bun.write('/tmp/scripts-spike-ws/b.md',  'B');

     const fs = new MountableFs({ base: new InMemoryFs() });
     fs.mount('/workspace', new ReadWriteFs({ root: '/tmp/scripts-spike-ws' }));

     const invocations: Array<{path: string, args: unknown}> = [];
     const bash = new Bash({
       fs,
       cwd: '/workspace',
       executionLimits: { maxJsTimeoutMs: 30_000 },
       javascript: {
         bootstrap: SWARM_BOOTSTRAP,
         invokeTool: async (path, argsJson) => {
           const args = argsJson ? JSON.parse(argsJson) : {};
           invocations.push({ path, args });
           if (path === 'tasks.list') return JSON.stringify([{ id: 't1' }]);
           throw new Error(`Unknown tool: ${path}`);
         },
       },
     });

     const ac = new AbortController();
     setTimeout(() => ac.abort(), 2000);
     const r = await bash.exec(`js-exec -m -c '${SCRIPT_SOURCE.replace(/'/g, "\\'")}'`, {
       signal: ac.signal,
     });

     // Assertions
     expect(r.exitCode).toBe(0);
     const out = JSON.parse(r.stdout.trim());
     expect(out.tasks).toEqual([{ id: 't1' }]);
     expect(out.cwd).toBe('/workspace');
     expect(out.files.sort()).toEqual(['a.txt', 'b.md']);
     expect(out.bearer).toBe('undefined');           // ← key assertion
     expect(invocations).toEqual([{ path: 'tasks.list', args: { status: 'open' }}]);
   });

   it('aborts a runaway script', async () => {
     const bash = new Bash({ javascript: true, executionLimits: { maxJsTimeoutMs: 30_000 }});
     const ac = new AbortController();
     setTimeout(() => ac.abort(), 500);
     const t = Date.now();
     const r = await bash.exec(`js-exec -c 'while(true){}'`, { signal: ac.signal });
     expect(r.exitCode).toBe(124);
     expect(Date.now() - t).toBeLessThan(2000);
   });
   ```

3. **Cold-start measurement**: time three back-to-back `bash.exec`
   calls and log to stdout. Sanity-check the ~10-30 ms warm path.

### Pass/fail criteria

- **PASS** = both tests green AND `out.bearer === 'undefined'` AND
  cold-start measurement is < 1 second per call.
- **FAIL** = any test red, OR cold-start > 1 second per call, OR the
  patch from PR #169 doesn't cleanly apply.

### Estimated effort

- 30 min: apply PR #169 patch and verify js-exec works.
- 60 min: write spike.ts + fixture + 2 tests.
- 30 min: cold-start measurement + writeup.

**~2 hours total.** If the patch is hard to apply, add 1 hour for
vendoring a worker file. Half-day budget is appropriate.

---

## 10. Stdlib v1 — revised

### The choice

The prior research doc (Decision #5) recommended JS-native helpers:
`fetch`, `grep`, `glob`, `table` + full `swarm.*`. With just-bash in the
picture, three new options open:

| Option | Pros | Cons |
|---|---|---|
| **(A) Drop JS stdlib helpers; expose `ctx.bash.exec()` for bash builtins** | Massive ergonomics win — `ctx.bash.exec('jq . file.json')` instead of writing JSON parsing. just-bash already ships 79+ commands. | Two mental models for scripts: native JS for data-shape, shell for ops. Stdout parsing required. |
| **(B) Keep JS stdlib helpers, hide bash entirely** | Pure JS feel. Typed inputs/outputs. | Reinvents `jq`, `awk`, `grep`, `glob` — wasted effort. |
| **(C) Hybrid: `swarm.*` (host-resolved) + `ctx.bash.exec()` (just-bash) + tiny `ctx.stdlib.{table, parse}` for output formatting** | Best of both. Bash for one-liners, JS for structured transforms, formatters for pretty output. | Surface area is bigger. |

### Recommendation: **(A)** — drop the JS stdlib, expose bash

Reasons:

1. **Code-mode shipped JS helpers because it had no bash sandbox**.
   We do. `grep`, `glob`, `fetch` (gated), `jq`, `awk`, `sed`, `column`,
   `xan` (CSV) all ship as bash builtins. Re-implementing them in JS
   stdlib duplicates effort.
2. **Bun's `child_process.execSync` is exposed inside QuickJS**
   (`js-exec-worker.ts:261-281`). Scripts can do:
   ```js
   const { execSync } = require('node:child_process');
   const json = JSON.parse(execSync('cat data.json | jq ".items[]"'));
   ```
   ZERO marginal cost.
3. **`table` is the only one worth keeping** for pretty output. Ship it
   as a single host-resolved tool `swarm.format.table(rows)` returning
   a string. ~20 lines.
4. **`fetch`** is already covered by either `swarm.fetch(...)` (future
   host bridge) or `js-exec`'s built-in `fetch` (gated by `network:` config).
   No wrapper needed.

### Revised stdlib v1

- **JS stdlib helpers**: **NONE.** Maybe `ctx.format.table(rows)` as a
  utility (resolves via `invokeTool`).
- **Bash builtins**: ALL 79+ available via `child_process.execSync` /
  `spawnSync` from inside `js-exec` (no opt-in needed, no security
  surface beyond what bash already grants).
- **`swarm.*`** (8 domains): unchanged from brainstorm Decision #6.

### Plan impact

- Original Phase "Stdlib helpers" → COLLAPSES to "Add `swarm.format.table`
  bridge helper (optional)".
- Saves ~200 LOC of JS helper plumbing.

---

## 11. Plan deltas

### What changes vs the original research doc

| Decision (prior doc) | Status now |
|---|---|
| #1 Versioning (mutable + `script_versions` audit table) | UNCHANGED |
| **#2 Sandbox: Bun.spawn + ulimit** | **REPLACED by just-bash. Subject to spike pass.** |
| #3 Promotion via `isLead` | UNCHANGED |
| #4 Packaging (in-repo `src/scripts-runtime/`) | UNCHANGED |
| **#5 Stdlib (`fetch`+`grep`+`glob`+`table`)** | **REVISED → no JS stdlib helpers; bash builtins via `child_process.execSync`; optional `swarm.format.table` only** |
| #6 No code-mode importer | UNCHANGED |
| #7 No CLI v1 | UNCHANGED |

### New / re-ordered phases for `/desplega:create-plan`

**Phase 0 (NEW, blocking)**: just-bash integration spike (§9). MUST pass
before any further build. Owner output: a runnable `bun test src/scripts-runtime/spike/spike.test.ts` that prints "PASS".

**Phase 1 (was: storage)**: SQLite schema for `scripts` +
`script_versions`. Same as before — independent of runtime choice.

**Phase 2 (was: runtime — Bun.spawn)**: REPLACE entirely with
`src/scripts-runtime/{loader.ts, ctx.ts, fs-config.ts, swarm-resolver.ts}`
that wraps just-bash. Key files to author:

- `loader.ts` — accepts `{ source, args, fsMode, workspacePath?, agentId, signal }`,
  builds a `Bash` instance with `MountableFs` per fsMode, evaluates the
  script (probably wrap user `export default` in a small harness that
  calls it with `args` and `ctx`).
- `swarm-resolver.ts` — the `invokeTool` resolver: maps `tasks.create`
  etc. to internal HTTP routes, injects bearer + `X-Agent-ID`, scrubs
  response with `secretScrubber`.
- `bootstrap.ts` — exports the `SWARM_PROXY_BOOTSTRAP` string + maybe a
  `ctx` wrapper.

**Phase 3 (was: MCP tools)**: UNCHANGED. `script_search`/`script_run`/
`script_upsert`/`script_delete`/`script_query_types`.

**Phase 4 (was: embeddings)**: UNCHANGED.

**Phase 5 (was: workflow node)**: UNCHANGED, but the new node type's
implementation lives in Phase 2's runtime package.

**Phase 6 (was: CLI)**: DEFERRED (per prior doc).

### Load-bearing things the planner must double-check

1. **PR #169 patch strategy** — Bun `patchedDependencies` vs vendored
   worker. Decide early; document the patch-removal step once upstream
   merges.
2. **Disk-footprint** — ~100 MB `node_modules` increase from CPython
   vendoring. Verify this is acceptable for the docker worker image
   (it has CPython already). Possibly add `just-bash` to the `.dockerignore`
   for the API container if the API doesn't need workspace-mounting
   modes (`fs: 'none'` only).
3. **`maxJsTimeoutMs`** must be threaded through the script runtime — per
   the `executionLimits` API. Default 30s, max 300s per the prior plan.
4. **CLAUDE.md update** — add an `<important if="modifying scripts-runtime">`
   block explaining the just-bash quirks (PR #169 patch, `python: true`
   off, default-deny network, FS mode contract).
5. **Auth-resolver scrubbing** — apply `scrubSecrets` to the JSON
   response inside the `invokeTool` resolver before returning to the
   guest. Belt-and-braces.
6. **Per-task instance pooling** — Phase 2 should ship a tiny `BashPool`
   that hands out warmed `Bash` instances per (`fsMode`, `workspacePath`)
   tuple. Without it, each `script_run` pays a worker-init cost.

### Risks log (for the plan)

- **R1 (HIGH)**: PR #169 doesn't land upstream and the patch we carry
  drifts. Mitigation: vendor a stable patched `js-exec-worker.js`,
  version-pin and re-validate quarterly.
- **R2 (MEDIUM)**: just-bash v4 ships a breaking change to `invokeTool` /
  `MountableFs`. Mitigation: pin exact version; add a smoke test that
  exercises the integration surface on dep-bump.
- **R3 (LOW)**: QuickJS WASM bundle adds noticeable cold-start to API
  server. Mitigation: lazy-init the pool only when first `script_run`
  arrives; warm only one instance until traffic warrants more.

---

## Appendix: file:line index

For the planner's convenience, every claim above maps to:

- `packages/just-bash/src/Bash.ts:91-112` — `JavaScriptConfig` (bootstrap + invokeTool)
- `packages/just-bash/src/Bash.ts:282-285` — `ExecOptions.signal`
- `packages/just-bash/src/Bash.ts:351-356` — secureFetch construction
- `packages/just-bash/src/Bash.ts:480-497` — JS commands registration / bootstrap wiring
- `packages/just-bash/src/commands/js-exec/js-exec.ts:218` — singleton worker
- `packages/just-bash/src/commands/js-exec/js-exec.ts:376-384` — 5s idle termination
- `packages/just-bash/src/commands/js-exec/js-exec.ts:438-457` — timeout / worker terminate
- `packages/just-bash/src/commands/js-exec/js-exec-worker.ts:12` — **the failing import**
- `packages/just-bash/src/commands/js-exec/js-exec-worker.ts:80` — 64 MB memory limit
- `packages/just-bash/src/commands/js-exec/js-exec-worker.ts:776-796` — `__invokeTool` registration
- `packages/just-bash/src/commands/js-exec/js-exec-worker.ts:1098-1115` — `tools` proxy source
- `packages/just-bash/src/commands/js-exec/js-exec-worker.ts:1340-1367` — bootstrap → tools-setup order
- `packages/just-bash/src/commands/worker-bridge/sync-backend.ts:28-63` — `execSync` SAB protocol
- `packages/just-bash/src/commands/worker-bridge/sync-backend.ts:312-321` — `invokeTool` from worker
- `packages/just-bash/src/commands/worker-bridge/bridge-handler.ts:598-626` — host-side resolver
- `packages/just-bash/src/fs/interface.ts:118-286` — `IFileSystem` (async-only)
- `packages/just-bash/src/fs/mountable-fs/mountable-fs.ts:64-200` — MountableFs core
- `packages/just-bash/src/fs/read-write-fs/read-write-fs.ts:69-115` — TOCTOU-safe gating
- `packages/just-bash/src/network/types.ts:54-134` — NetworkConfig
- `packages/just-bash/src/network/types.ts:182-191` — MethodNotAllowedError
- `packages/just-bash/src/limits.ts:71-90` — default execution limits
- `packages/just-bash/src/custom-commands.ts:44-49` — `defineCommand`
- `packages/just-bash/package.json:107-127` — runtime deps
- `packages/just-bash/package.json:116` — `quickjs-emscripten` (hard dep)
- `packages/just-bash/README.md:7` — beta status
- `packages/just-bash/README.md:200` — "don't point ReadWriteFs at runtime code" warning
- `packages/just-bash/README.md:244-294` — network defaults / allow-list
- `packages/just-bash/README.md:557-573` — Execution Protection
- `packages/just-bash/LICENSE:1-3` — Apache-2.0
- `packages/just-bash-executor/README.md:137-139` — `await` is decorative
- `packages/just-bash-executor/README.md:362-385` — `invokeTool` shape

External:
- https://github.com/vercel-labs/just-bash/issues/159 — js-exec failing in bun
- https://github.com/vercel-labs/just-bash/pull/169 — proposed fix (open, idle)
- https://github.com/vercel-labs/just-bash/pull/188 — per-URL method restrictions (open)
- https://github.com/vercel-labs/just-bash/blob/main/THREAT_MODEL.md — full security model
