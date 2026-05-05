---
date: 2026-05-03
source: Linear DES-294 (opencode/sst-opencode harness provider)
prs: #399 #400 #403 #406 #407 #409 #410 #412 #413
autonomy: critical
status: integration works end-to-end with manual model selection; CI build was broken; 4 follow-up bugs found
---

# QA: opencode Harness Provider (DES-294)

## TL;DR

The opencode harness provider runs end-to-end — a worker container picks up a task, opencode reasons + calls swarm MCP tools + writes the requested file with correct content. **But CI was broken** and there are several follow-up bugs that didn't get caught because the only e2e signal in CI is `Docker Build + Publish + Deploy`, which never reached the runtime path before this QA.

Fixes already applied in this branch:
- `Dockerfile.worker` — opencode version pin, missing `ENV PATH`, root-owned `~/.cache`
- `scripts/e2e-docker-opencode.ts` — forward `MODEL_OVERRIDE` to worker container

Open issues (none of which I've fixed yet — listed below for follow-up).

## What was tested

| # | What | Result |
|---|---|---|
| 1 | Docker build (`docker build -f Dockerfile.worker .`) | ✅ after 3 fixes |
| 2 | `opencode --version` inside image, in non-interactive PATH | ✅ `1.14.30` |
| 3 | Worker entrypoint with `HARNESS_PROVIDER=opencode` | ✅ passes credential + binary checks |
| 4 | API server + worker container + posted task "write hello.txt" | ✅ task completes, file written with exact content `opencode-e2e-ok` |
| 5 | MCP tool calls from inside opencode (`swarm_memory-search`, etc.) | ✅ visible in `session_logs` and API access logs |
| 6 | Plugin loaded — `/cancelled-tasks` poll seen in `/tmp/api.log` | ✅ (via opencode auto-discovery, **not** via the `plugin: [...]` config — see bug #4 below) |
| 7 | `qwen/qwen3.6-flash` (Taras's requested model) | ❌ rejected by opencode bundled registry; `openrouter/qwen/qwen3-coder-flash` rejected by OpenRouter data policy; `openrouter/openai/gpt-5-nano` worked |
| 8 | `agent_tasks.provider`, `agent_tasks.model`, `agents.provider`, `agents.lastActivityAt` after a successful run | ❌ all `null` in DB |
| 9 | `session_costs` row from opencode SSE | ❌ row exists but is from MCP `store-progress` (model=`opus`, zero tokens) — opencode SSE cost path not reaching DB |
| 10 | Runner-side cost submission | ❌ `[runner] Failed to save cost data: 400` |

## Critical issue (already fixed): Docker CI build broken

**Failure:** `Docker Build + Publish + Deploy` failing on every push to `main` since DES-302 (#407) was merged.

**Root cause:** `Dockerfile.worker:126` pinned `OPENCODE_VERSION=0.5.10`, but `opencode.ai/install` redirects to `anomalyco/opencode` which has never published `v0.5.10` (earliest tag is `v1.3.17`). The release page returns a 301 (so the install script's tag-existence check passes), but the actual `releases/download/v0.5.10/opencode-linux-x64.tar.gz` returns a 9-byte HTTP 404 body. `curl ... | bash` pipes that into the script, which then pipes it into `tar xz` → `gzip: stdin: not in gzip format` → `tar: Child returned status 1` → exit 2.

**Evidence:**
```
v0.5.10:  HTTP 404 size=9
v1.14.30: HTTP 200 size=51672281
```

**Fix applied (`Dockerfile.worker:128`):** `ARG OPENCODE_VERSION=1.14.30` (matches `OPENCODE_SDK_VERSION` and the `@opencode-ai/sdk` pin in `package.json`). The SDK requires the matching binary because `node_modules/@opencode-ai/sdk/dist/server.js` literally does:
```js
import launch from "cross-spawn";
const proc = launch(`opencode`, args, { env: ... });
```
There is no in-process mode — answering the "do we even need the install" question Taras raised.

## Follow-up bug 1 (already fixed): opencode binary not in non-interactive `PATH`

**Failure:** Even with the install succeeding, `command -v opencode` from the entrypoint (`/bin/sh`) returned nothing. The installer drops the binary at `~/.opencode/bin/opencode` and only modifies `~/.bashrc` — that PATH update never reaches non-interactive shells, gosu drops, or the `cross-spawn` call inside the SDK. `docker-entrypoint.sh:166` would `FATAL: opencode CLI not found` in production even with a successful install.

**Fix applied (`Dockerfile.worker:131`):** `ENV PATH="/home/worker/.opencode/bin:$PATH"` immediately after the installer.

## Follow-up bug 2 (already fixed): `~/.cache` owned by root, opencode can't initialize

**Failure:** First runtime attempt aborted with:
```
EACCES: permission denied, mkdir '/home/worker/.cache/opencode'
    path: "/home/worker/.cache/opencode", syscall: "mkdir", errno: -13
```

**Root cause:** `Dockerfile.worker:171` switches to `USER root` for the global npm install + `qa-use install-deps` and never switches back. Those steps create `/home/worker/.cache/...` as `root:root`, which `worker` (uid 1001) can't write to at runtime.

**Fix applied (`Dockerfile.worker:181`):** `RUN chown -R worker:worker /home/worker` after the root-side installs. Targeted at the right point — late enough to capture all root-owned droppings, early enough that the binary `COPY` doesn't have to be re-chowned.

## Open bug 3: bundled opencode registry rejects `qwen/qwen3.6-flash`

**Symptom:** opencode session errors with:
```
{"error":{"name":"UnknownError","data":{"message":"Model not found: qwen/qwen3.6-flash."}}}
```

**Root cause:** opencode resolves model IDs against its bundled provider/model registry (powered by `models.dev`). The exact model `qwen/qwen3.6-flash` exists on OpenRouter (verified — see `qwen/qwen3.6-{flash,35b-a3b,max-preview,27b,plus}` in OpenRouter `/api/v1/models`), but opencode's bundled registry only knows `openrouter/qwen/qwen3.6-plus` from that family. Trying `openrouter/qwen/qwen3.6-flash` fails the same way; trying `openrouter/qwen/qwen3-coder-flash` reaches OpenRouter but is blocked by:
```
"No endpoints available matching your guardrail restrictions and data policy.
 Configure: https://openrouter.ai/settings/privacy"
```

**What worked:** `MODEL_OVERRIDE=openrouter/openai/gpt-5-nano` — task completed, file written, exit 0.

**Suggested next step for Taras:** Either (a) bump opencode CLI to a newer release that ships an updated `models.dev` snapshot including the qwen3.6 family, or (b) add a custom provider/model entry in the per-task config in `OpencodeAdapter.createSession()`. Also worth flipping the OpenRouter data-policy switch so models like `qwen3-coder-flash` work.

## Open bug 4: per-task `pluginPath` resolves to a non-existent path

**Code:** `src/providers/opencode-adapter.ts:295`
```ts
const pluginPath = join(import.meta.dir, "../../plugin/opencode-plugins/agent-swarm.ts");
```

**Problem:** When the bundled binary at `/usr/local/bin/agent-swarm` runs, `import.meta.dir = "/usr/local/bin"`, so `pluginPath = "/plugin/opencode-plugins/agent-swarm.ts"` — a path that does not exist. Verified by `ls /plugin/...` from inside the container (file not found).

**Why nothing visibly broke:** opencode auto-discovers plugins from `~/.config/opencode/plugins/`, where the Dockerfile copies the plugin (`Dockerfile.worker:46`). The explicit `plugin: [...]` config entry pointing at the missing path is silently ignored. So the plugin DID load — `/cancelled-tasks` polls hit the API during the test run — but only by accident of opencode's discovery rules, not because the adapter pointed it correctly.

**Why this still matters:**
- Brittle. If opencode changes plugin discovery (e.g. requires explicit registration when `OPENCODE_CONFIG` is set), the swarm plugin silently stops working — no cancellation, no heartbeat, no identity sync.
- In dev (`bun src/cli.tsx`) `import.meta.dir` is the source dir, so it works. The two execution modes diverge silently.

**Suggested fix:**
```ts
const pluginPath =
  process.env.OPENCODE_SWARM_PLUGIN_PATH ??
  (existsSync("/home/worker/.config/opencode/plugins/agent-swarm.ts")
    ? "/home/worker/.config/opencode/plugins/agent-swarm.ts"
    : join(import.meta.dir, "../../plugin/opencode-plugins/agent-swarm.ts"));
```
And export `ENV OPENCODE_SWARM_PLUGIN_PATH=/home/worker/.config/opencode/plugins/agent-swarm.ts` from `Dockerfile.worker` for clarity.

## Open bug 5: `agent_tasks.provider` and `.model` never set

After a successful opencode task run:
```
agent_tasks.id = 126aef39-...
agent_tasks.status = completed
agent_tasks.provider = NULL    ← expected 'opencode'
agent_tasks.model    = NULL    ← expected 'openrouter/openai/gpt-5-nano'
```
The e2e `basic` test currently `logSkip`s when this is NULL (`scripts/e2e-docker-opencode.ts:336`), so the test is green even when this field never gets written. Either the runner is supposed to PUT this and isn't, or the API reject path swallows it. Worth tracing where `agent_tasks.provider` gets written for the working `claude` provider and checking why the same path isn't firing for opencode.

## Open bug 6: `agents.provider` and `agents.lastActivityAt` stay NULL

```
agents.provider       = NULL    ← expected 'opencode'
agents.lastActivityAt = NULL    ← heartbeat plugin should be writing this
```
Cancellation polling (`/cancelled-tasks?taskId=...`) is firing, so the plugin IS executing. But the heartbeat path isn't reaching `agents.lastActivityAt`. Worth checking `plugin/opencode-plugins/agent-swarm.ts` for which endpoint the heartbeat hits and whether the API handler actually writes the field.

## Open bug 7: cost data submission fails + wrong cost row persisted

Worker stderr:
```
[runner] Failed to save cost data: 400
```

DB has a `session_costs` row for the task, but it's the one written by the MCP `store-progress` call inside the task itself (model=`opus`, zero tokens, costSource=`harness`). The opencode-side cost data computed from SSE events (which the adapter accumulates from `message.updated`) never reached the DB. So budgets/cost analytics will be wrong for opencode tasks until this is fixed.

## Files changed in this QA branch (uncommitted)

```
Dockerfile.worker              | 9 +++++++++   (3 fixes: version, PATH, chown)
scripts/e2e-docker-opencode.ts | 3 +++         (forward MODEL_OVERRIDE)
```

## Repro commands

```bash
# 1. Build
docker build -f Dockerfile.worker -t agent-swarm-worker:e2e .

# 2. Sanity check the binary
docker run --rm --entrypoint /bin/sh agent-swarm-worker:e2e \
  -c 'command -v opencode && opencode --version'   # /home/worker/.opencode/bin/opencode 1.14.30

# 3. e2e (use a model that works)
MODEL_OVERRIDE=openrouter/openai/gpt-5-nano \
  bun scripts/e2e-docker-opencode.ts --test basic --skip-build
```

(`OPENROUTER_API_KEY` auto-loaded from `.env` by Bun.)
