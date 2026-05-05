---
date: 2026-05-03
parent_qa: thoughts/taras/qa/2026-05-03-opencode-integration-des294.md
parent_pr: https://github.com/desplega-ai/agent-swarm/pull/416
parent_branch: fix/des-294-opencode-docker-build
status: open — pick up in fresh session
type: handoff
---

# Handoff plan: persist `agent_tasks.model` + `agents.provider`

## What's done already (PR #416)

Branch `fix/des-294-opencode-docker-build` has three commits, all pushed:

- `9dcc68b1` — docker build unbreak (`OPENCODE_VERSION` 0.5.10→1.14.30, `ENV PATH` for opencode bin, `chown -R worker:worker /home/worker`)
- `4c088c27` — pluginPath resolver, `OpencodeSession` event buffering, `"opencode"` added to `/api/session-costs` provider enum, plugin `/heartbeat`→`/activity`, UI session-log parser for opencode events, DB-boundary script extended to `plugin/opencode-plugins/`
- `6eca0621` — adapter emits `context_usage` + `tool_start`/`tool_end`; `store-progress` MCP tool drops zero-filled `costData` payloads

End-to-end verified against opencode + `openrouter/openai/gpt-5-nano`: task picks up, file written, exit 0, real cost row, single correct model in UI, context-usage bar working, activity timeline populated.

## What's open

Two pre-existing NULL-column gaps that are NOT opencode-specific (no provider populates them today). Both columns exist in the schema; nothing writes to them.

### Bug A: `agent_tasks.model` always NULL

The runner sends `provider` via `PUT /api/tasks/:id/claude-session` but not `model`.

**Files to edit:**

1. `src/http/tasks.ts` — `updateClaudeSession` route's body union (around lines 82–97). Add `model: z.string().optional()` to BOTH branches of the `z.union([...])`.
2. `src/be/db.ts` — `updateTaskClaudeSessionId()` at line 1076. Add a `model?: string` parameter and append `model = ?` to `setClauses` (mirror the existing `provider` pattern immediately above).
3. `src/http/tasks.ts` — handler call site (line 310). Pass `parsed.body.model` into `updateTaskClaudeSessionId(...)`.
4. `src/commands/runner.ts` — `saveProviderSessionId()` at line 1046. Add an optional `model?: string` parameter and include it in the body (mirror `provider` at lines 1057–1058).
5. `src/commands/runner.ts` — at the `session_init` call site (line 1741), pass `opts.model` into `saveProviderSessionId`. (`opts.model` is the runner-resolved value from `MODEL_OVERRIDE` / task config — authoritative. `event.cost?.model` only arrives at `result` time, too late.)

**Verification:**
```bash
sqlite3 /tmp/e2e-manual-1777833400.sqlite \
  "SELECT model FROM agent_tasks WHERE id='<recent-task-id>'"
# → 'openrouter/openai/gpt-5-nano' (or whatever was configured), not NULL
```

### Bug B: `agents.provider` always NULL

Migration `048_agent_provider.sql` added the column but no code path writes it.

**Approach (recommended):** worker tells API on registration what its harness is.

**Files to edit:**

1. `src/http/agents.ts` — `registerAgent` route body schema (around line 30). Add `provider: ProviderNameSchema.optional()`. Import `ProviderNameSchema` from `@/types`.
2. `src/be/db.ts` — `registerAgent()` / `createAgent()` SQL. Find via:
   ```bash
   grep -n "INSERT INTO agents" src/be/db.ts
   ```
   Add `provider` to the INSERT and the function signature. Also handle the upsert / re-register path so existing agents get the field set on next registration.
3. `src/http/agents.ts` — handler (search for `registerAgent.match`). Pass `parsed.body.provider` into the DB call.
4. `src/commands/runner.ts` — agent-registration POST (search for `'/api/agents'` or the body with `name:` and `role:`). Send `provider: process.env.HARNESS_PROVIDER || 'claude'`.

**Verification:**
```bash
sqlite3 /tmp/e2e-manual-1777833400.sqlite \
  "SELECT id, name, provider FROM agents WHERE provider IS NOT NULL"
# Should list every recently-registered agent with its harness provider
```

## Local dev state at handoff time

| What | Where | Notes |
|---|---|---|
| API server | `localhost:13098` (`pkill -f 'src/http.ts'` to stop) | DB `/tmp/e2e-manual-1777833400.sqlite`, `API_KEY=123123` |
| UI dev server | `localhost:5274` | `cd new-ui && VITE_PROXY_TARGET=http://localhost:13098 npx vite --port 5274 --host` |
| Worker container | `manual4` | image `agent-swarm-worker:e2e`, `HARNESS_PROVIDER=opencode`, `MODEL_OVERRIDE=openrouter/openai/gpt-5-nano`, agent UUID in `/tmp/agent.txt` |
| Helper scripts | `/tmp/post-with-agent.ts`, `/tmp/posttask4.ts`, `/tmp/verify4.ts` | Bun-runnable; register agent / post task / dump cost rows |

`OPENROUTER_API_KEY` lives in `.env` (auto-loaded by Bun).

## After both fixes — checklist

```bash
bun run tsc:check
bun run lint
bun test src/tests/opencode-adapter.test.ts src/tests/credentials.test.ts src/tests/provider-adapter.test.ts
bash scripts/check-db-boundary.sh
docker build -f Dockerfile.worker -t agent-swarm-worker:e2e .
bun run docs:openapi   # if route schemas changed
```

Then restart API, restart worker container, post a fresh task, verify DB columns populated, refresh UI task page (model chip should appear next to provider chip in the header), commit + push to the same branch.

## Gotchas

- Don't bypass `route()` factory in `src/http/` — auto-registers OpenAPI. After editing routes, run `bun run docs:openapi` and commit `openapi.json` (CI enforces freshness).
- Worker code MUST NOT import `bun:sqlite` or `src/be/db` (`scripts/check-db-boundary.sh` runs in pre-push). All worker→DB writes go through the API.
- `/api/tasks/:id/claude-session` accepts BOTH a Devin-specific body shape AND a generic shape (`z.union([...])`). Add the model field to BOTH branches (or only the generic one if you'd rather scope it — but keep parity with how `provider` was added there).
- `saveProviderSessionId` is also called from `saveProviderSessionIdOnActiveSession` (pool tasks; line 1151 of runner.ts). That path uses the `active_sessions` table, which likely doesn't have a `model` column — confirm before touching, and if not present, leave the pool path alone (out of scope).
