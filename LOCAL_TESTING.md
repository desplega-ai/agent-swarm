# Local Testing

Reference doc for everything Claude (or any agent) needs to test Agent Swarm locally. Covers unit tests, E2E Docker, Docker entrypoint round-trips, MCP handshake, and UI verification.

Quick index:

- [Unit tests](#unit-tests)
- [E2E with Docker](#e2e-with-docker) — full flow lives in the `swarm-local-e2e` skill
- [Docker entrypoint changes](#docker-entrypoint-changes)
- [MCP tool testing over HTTP](#mcp-tool-testing-over-http)
- [Dashboard UI](#dashboard-ui)
- [Port-conflict resolution](#port-conflict-resolution)

## Unit tests

Runner: `bun run test:root` (workspace root). Bun version: the one in `package.json` `packageManager` (CI installs exactly that; `bun scripts/check-bun-version.ts` asserts the Dockerfiles match it).

```bash
bun run test:root -- --parallel=4                      # all unit tests, 4 worker processes (~90s)
bun run test:root                                      # all unit tests, one process (~4 min)
bun run test:root -- src/tests/<file>.test.ts          # one file
bun run test:root -- --watch src/tests/<file>.test.ts
bun run test:root -- --parallel=4 --changed=$(git merge-base origin/main HEAD)   # only files affected by this branch
bun run test:root -- --parallel=4 --shard=1/2                                    # CI shard 1 (CI also passes restored --timings files)
```

`--parallel=N` runs each test file in its own worker process (it implies `--isolate`), so files cannot see each other's module mocks, globals, or leaked handles. `--changed=<ref>` selects test files whose import graph touches files changed since `<ref>`; always pass the **merge-base**, not `origin/main` itself, or every upstream commit counts as a change (0 files on a docs-only branch, ~20 files for a leaf tool edit). `--shard=N/M` splits files by count; CI adds `--timings=<file>` entries restored from the actions cache (per-file durations written by the previous green run's `--update-timings`, merged by the `save-timings` job; the `restore-timings` job resolves the snapshot once and both shards download the same artifact, so they always split the same file list) so the split is by total time. Nothing is committed; the first run after a cache wipe splits by count. Locally you can do the same with `--update-timings --timings=/tmp/timings.json`.

Before selecting tests, `scripts/pre-push-tests.sh` runs a file-backed Bun process through the production sandbox limits. When the probe exits 134, the hook sets `SWARM_SKIP_SANDBOX_SPAWN_TESTS=1` and skips only spawn-dependent tests in `scripts-runtime`, `script-workflows-runtime-e2e`, `scripts-mcp-e2e`, `sandboxed-process`, `scripts-runtime-identity`, and `slack-read-boundaries`; all other affected tests still run. `RLIMIT_NPROC` is enforced per UID, so the sandbox's 512-process ceiling can prevent Bun 1.4.0 from starting when host-wide swarm thread usage for the worker UID is already high. CI does not set the variable and runs every sandbox test.

Conventions:

- Each test file uses an **isolated SQLite DB**: `./test-<name>.sqlite`. Call `initDb()` in `beforeAll`, `closeDb()` in `afterAll`. `src/tests/preload.ts` restores a pre-migrated template (cached under `$TMPDIR/agent-swarm-test-template/`, keyed by migrations + prompt registry + Bun version) so `initDb()` costs a file read, not 130 migrations. `AGENT_SWARM_TEST_TEMPLATE_CACHE=0` bypasses the cache for a run (no read, no write); entries untouched for a day are pruned.
- Tests that need an HTTP surface use a **minimal `node:http` handler** — not the full `src/http.ts` server. Keeps startup cheap and isolates what's under test.
- **Never hard-code a port.** Helpers live in `src/tests/test-net.ts`: in-process `node:http` servers use `const port = await listenOnFreePort(server)`; `Bun.serve({ port: 0 })` servers read `server.port`; spawned `src/http.ts` children take `await getFreePort()` in `beforeAll` and wait with `waitForServer(url)` inside a hook given `SERVER_BOOT_HOOK_TIMEOUT_MS`. Under `--parallel` two files with the same literal collide and one of them hits "Server did not start within 60000ms".
- In `afterAll`, clean up the `.sqlite`, `-wal`, and `-shm` files — or the next run inherits stale state.
- **No global retry.** `bunfig.toml` does not set `retry`; a test that is timing-sensitive by design opts in with `test(name, fn, { retry: 2 })` and a comment saying why, so flakes stay visible.
- The pre-push hook (`prek.toml` -> `scripts/pre-push-tests.sh`) runs the `--changed` form, or the full `--parallel=4` suite when migrations, `templates/`, `bunfig.toml`, `package.json`, or `bun.lock` changed (or `origin/main` is missing). If its sandbox spawn probe exits 134, it skips the spawn-dependent tests described above. Blocking; CI remains authoritative.

Memory-system tests have their own required suite (see `src/be/memory/` changes in the root `CLAUDE.md`).

Two RBAC suites spawn the **real** server as a subprocess (exception to the minimal-handler convention — the wire path IS what's under test):

- `bun run test:root -- src/tests/rbac-wire-e2e.test.ts` — gate matrix over a real MCP handshake + HTTP, plus audit-trail fidelity. Runs in the default root test command (CI).
- `RBAC_LIFECYCLE_E2E=1 bun run test:root -- src/tests/rbac-lifecycle-e2e.test.ts` — audit lifecycle (burst flush, SIGTERM drain, kill-switch, retention purge, boot-race, stdio). Env-gated, ~20s, multiple server boots; run on demand / pre-release. Skipped without the flag.

## E2E with Docker

Use the **`swarm-local-e2e` skill** — it owns the full flow (start API, build image, start lead + worker, create tasks, verify registration, check session logs, cleanup). Invoke it when:

- You changed code in `src/commands/runner.ts`, `src/providers/`, task-lifecycle paths, or `docker-entrypoint.sh`.
- You need to verify log isolation between sequential tasks on the same agent.
- You want a visual round-trip through the dashboard.

Gotchas the skill covers but worth calling out here:

- **Check `.env` for `PORT`** before spawning anything — `lsof -i :3013` to verify. Worktrees can have different ports.
- **`.env.docker-lead`** has a lead-specific `AGENT_ID` and no `OPENROUTER_API_KEY`. `AGENT_ROLE=lead` must be passed via `docker run -e`, not the env file.
- **Keep test tasks trivial** ("Say hi"). E2E is a smoke test, not a workload test.
- **Task cancellation caveat**: direct DB updates bypass hook-based cancellation. Use the MCP `cancel-task` tool, or `docker restart <container>` to force-stop the inner Claude process.

### Minimal smoke-test (when the skill is overkill)

If you only need to verify the API boots and workers register — no tasks, no UI:

```bash
# 1. Clean DB + start API
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &

# 2. Build worker image (slim is faster and sufficient for smoke tests;
#    use `bun run docker:build:worker` + :latest when the test needs
#    playwright/qa-use, postgres/redis, or glab)
bun run docker:build:worker:slim

# 3. Start lead + worker (use branch-specific names to avoid worktree collisions)
SUFFIX=$(git branch --show-current | tr '/' '-')
docker run --rm -d --name e2e-lead-$SUFFIX --env-file .env.docker-lead \
  -e AGENT_ROLE=lead -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:slim
docker run --rm -d --name e2e-worker-$SUFFIX --env-file .env.docker \
  -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:slim

# 4. Verify registration (wait ~15s first)
curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents \
  | jq '.agents[] | {name, isLead, status}'

# 5. Cleanup
docker stop e2e-lead-$SUFFIX e2e-worker-$SUFFIX
kill $(lsof -ti :3013)
```

## Docker entrypoint changes

`bash -n` is not sufficient validation for `docker-entrypoint.sh`. Run a full round-trip:

1. **Verify HTTP methods/paths** in entrypoint `curl` calls against route defs in `src/http/`. Common gotcha: config API is `PUT /api/config`, not `POST`.
2. **Test idempotency**: second boot with same `AGENT_ID` should skip re-registration (check via `GET /api/agents`).
3. **Test failure mode — two different contracts**:
   - *Optional external dependencies* (integrations, ecosystem restore, setup-script fetch, etc.) are best-effort: stop the dependency, boot the container, verify it continues via `|| true` guards rather than crashing.
   - *The control-plane API itself* is not best-effort. `wait_for_api_ready` in `docker-entrypoint.sh` polls `${MCP_URL}/health` once per second with bounded per-attempt `curl` timeouts before any provider-specific setup runs. Point `MCP_BASE_URL` at an unreachable host, set a short `WORKER_API_READY_TIMEOUT_SECONDS` (e.g. `5`), boot the container, and verify it exits non-zero with the stable `[entrypoint] FATAL: API readiness timed out after Ns waiting for <url>; exiting.` line — never a silent `|| true` continuation. See `src/tests/entrypoint-api-readiness.test.ts` for the extracted-helper regression coverage (immediate success, transient-then-success, unreachable/timeout, invalid timeout values, trailing-slash normalization, no leaked secrets).
4. **Test lead and worker paths separately**:
   - Lead: `--env-file .env.docker-lead -e AGENT_ROLE=lead`
   - Worker: `--env-file .env.docker`
5. **Grep boot logs**: `docker logs <name> 2>&1 | grep -i "<feature>"` to confirm the codepath ran.
6. **Verify persisted state**: `GET /api/config?includeSecrets=true` should show anything the entrypoint wrote to config.

## MCP tool testing over HTTP

MCP tools over Streamable HTTP require a session handshake before any tool call. Skipping it returns a session error.

### Handshake sequence

```bash
SESSION_ID=$(uuidgen)
AGENT_ID=$(uuidgen)   # must be a valid UUID — not an arbitrary string

# 1. Initialize
curl -sN -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl","version":"1"},"capabilities":{}}}' \
  -D -   # dump headers — grab mcp-session-id from the response

# 2. Notify initialized (no response expected)
curl -s -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "mcp-session-id: <session-id-from-step-1>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. Call a tool
curl -sN -X POST http://localhost:3013/mcp \
  -H "Authorization: Bearer 123123" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "mcp-session-id: <session-id>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<tool>","arguments":{}}}'
```

Required headers on every call:

- `Authorization: Bearer <API_KEY>`
- `X-Agent-ID: <uuid>` — validated as UUID; arbitrary strings rejected
- `Accept: application/json, text/event-stream` — **both** values required
- `mcp-session-id: <id>` — after step 1

## Dashboard UI

Defaults: UI on `APP_URL` (port 5274), API on `http://localhost:3013` (overridable via `VITE_API_URL`).

```bash
cd apps/ui && bun run dev   # port 5274
cd apps/ui && bun run dev --port 5275   # if 5274 is taken
```

### When you need to verify a UI change

Use the `qa-use` tool family:

- `/qa-use:explore <url>` — quick walkthrough, AI-powered element discovery
- `/qa-use:verify` — verify a defined feature
- `/qa-use:test-run` — run existing E2E tests

**PR requirement**: any PR touching `apps/ui/` or `apps/templates-ui/` must include a `qa-use` session with screenshots of the change running locally. Merge-gate enforces this.

### Port-conflict resolution

```bash
lsof -i :5274          # what's on the UI port
lsof -i :3013          # what's on the API port
```

If another worktree holds the port, either stop it or pick alternates and update `APP_URL` / `VITE_API_URL` accordingly.

## Port-conflict resolution

Worktrees frequently race for ports. Standard resolution:

1. **API port (`PORT` in `.env`, default 3013)**: `lsof -i :3013`. If occupied, pick an alternate and update:
   - `PORT` in `.env`
   - `MCP_BASE_URL` in `.env` (match the new port)
   - `MCP_BASE_URL` in `.env.docker` and `.env.docker-lead` (use `http://host.docker.internal:<new-port>`)
2. **UI port (`APP_URL`, default 5274)**: `lsof -i :5274`, restart dev server with `--port <alt>`, update `APP_URL` in `.env` if UI is reachable from outside.
3. **Docker mapped ports (3201 lead, 3203 worker)**: if another worktree's containers are up, use unique `-p <host>:3000` values and branch-specific `--name` suffixes (see the `swarm-local-e2e` skill).

Always verify via `curl` before proceeding — mismatched `MCP_BASE_URL` between API and Docker env files is the #1 silent E2E failure.
