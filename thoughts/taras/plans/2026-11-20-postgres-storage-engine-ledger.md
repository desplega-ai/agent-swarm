---
date: 2026-11-20
topic: "Ledger: Postgres as a second storage engine"
brief: thoughts/taras/brainstorms/2026-11-20-postgres-storage-engine-goal-prompt.md
brainstorm: thoughts/taras/brainstorms/2026-11-20-postgres-storage-engine.md
branch: feat/postgres-storage-engine (fork Capchase/agent-swarm)
---

# Ledger: Postgres as a second storage engine

## State

| Milestone | State | Head |
|---|---|---|
| M0 Baseline and spikes | done | see git log |
| M1 Stronger contract on SQLite | done (SQLite side); see M1 results | see git log |
| M2 Storage packages on SQLite | done (part 5): checks 1, 8, 16 on SQLite (see table); check 12 pending list at 32 files / 281 sites, every one owned by M4 or the SQLite start path (see Part 5) | `f3ce45ec5` |
| M3 Postgres engine | done (part 6): repositories, codec, baseline, triggers, runner, API start on Postgres (D1, D16); checks 7, 9, 14, 18 pass | `7b5952e21` |
| M4 Engine-specific domains | done (part 6): steps 1 to 5; check 12 at 0 pending sites | `14f212978` |
| M5 Contract on Postgres | done (part 10): D7 applied to the poll claim (87.5% -> 0%), task finish (71.7% -> 0%) and unkeyed task creation (68.6% -> 0%, `7084a65ef`); keyed task creation kept SERIALIZABLE (approved exception); four single-row or registration sites above 5% accepted as exceptions by Daniel (part 9) | `74403ae87` |
| M6 Data copy | done (part 9): `agent-swarm db-copy`, CLI and check-20 scenario `data-copy`, base-db fixture boots on Postgres through the copy (check 10), 4 contract tests | `f0480cc9a` |
| M7 Delivery | part 10: unkeyed creation fixed, webhook flake fixed, every check re-run on `216829ddf`; PR opened (see output) | `216829ddf` |

## Swarm adaptations (from the dispatching task, they win over the brief)

- Repo is the fork `Capchase/agent-swarm`. The PR goes to the fork `main`, never upstream.
- Worktree: `/workspace/personal/worktrees/pg-engine` (not `~/worktrees/...`).
- "Stop and ask Taras" means: the agent ends its task `failed` with `STOP-ASK:` and the evidence. Lead relays it.
- Postgres 16 + pgvector: no Docker in this container. The container has the Ubuntu packages `postgresql-16` 16.15 and `postgresql-16-pgvector` 0.6.0. The agent runs a private cluster (`initdb` + `pg_ctl`, port 55432, trust auth on 127.0.0.1, data in `/workspace/personal/pg-e2e/data`). CI uses `pgvector/pgvector:pg16` (pgvector 0.8.x). Risk: a pgvector feature newer than 0.6.0 works in CI and fails here. Rule: use only pgvector 0.6.0 features.
- This ledger is mirrored to agent-fs `shared/swarm-postgres/ledger.md` after each milestone.

## Base commit

`99d7de13a9a3f10db1bbb08d36072e7563d9190d` (fork `main` = upstream `main`, verified with `git rev-parse origin/main upstream/main` on 2026-11-20).

## Section 3 checks

Last updated part 6 (head `61477a358`).

| # | Check | Last run | Result |
|---|---|---|---|
| 1 | `bun run e2e:strict` (SQLite) | part 6, head `f1e1b2275` | **pass** (exit 0): 236 passed, 0 failed, 2 flaky (`slack-lead-follow-up-card`, `model-group-resolution`, both flaky before this work). `task-statuses` 10/10. |
| 2 | `bun run e2e:strict --engine postgres` | part 6, heads `a94edbdad` and `16631956a` | **fail / incomplete**: both runs hit the run timeout (50 and 65 min). Run 2: 196 passed, 54 failed attempts. Fixed groups re-pass with `--only`. Open: retry rates at task creation (D7, part 7 STOP-ASK). JSON key order decided part 7 (the two scenarios pass on Postgres). |
| 3, 4, 5 | same scenario list, `--tx-replay` on Postgres, divergence scenarios on Postgres | | not run on Postgres yet (6 of the 11 divergence scenarios pass on Postgres with `--only`; `divergence-values` passes since part 7) |
| 6 | no new coverage exclusion | | not checked yet |
| 7 | `bun run check:schema-parity` | part 6, head `16631956a` | **pass**: 0 unexplained, 164 allowlisted |
| 8 | no change to base migration files | part 6, head `61477a358` | **pass**: `git diff --name-status 99d7de13a -- 'src/be/migrations/*.sql'` lists 6 added files, 0 modified, deleted or renamed |
| 9 | `scripts/check-migration-conflicts.sh` with the Postgres chain | part 5 | pass (not re-run in part 6) |
| 10 | base-commit SQLite file starts on the branch | M1 scenario | passes in check 1 |
| 11 | `bun run check:dep-graph` rejects a driver import | part 6 | **pass**: planted `bun:sqlite` (in `src/` and in the Postgres package), `postgres`, `import { SQL } from "bun"` and `Bun.SQL` each fail it (exit 1); clean tree exit 0. Before part 6 a planted `Bun.SQL` passed; `check-driver-imports.ts` closes that. |
| 12 | `bun run check:storage-boundary` | part 6, head `14f212978` | **pass**: 0 pending sites. Permanent entries with reasons: composition root, `sql-connections.ts`, `db/runtime.ts`, `storage.ts`, `scripts/typecheck.ts`, and the seeded-scripts directory (needs review). |
| 13 | `bun run check:sql-portability` | part 6 | **pass** (2,753 templates) |
| 14 | `bun run check:no-new-triggers` | part 6 | **pass** |
| 15 | `bun run check:tx-callbacks` | part 6 | **pass** |
| 16 | existing gates | part 6 | `lint`, `lint:slop`, `tsc:check:tsc`, `check-db-boundary.sh`, `check-async-db-seam.sh`, `check-floating-promises.ts`, `check-promise-sinks.ts`, `check-audit-columns.sh`, `check:unit-test-allowlist`: pass. `test:root -- --parallel=4` (head `f1e1b2275`): exit 1, 23,077 pass / 22 fail. 2 were branch regressions, fixed in `61477a358` (package-publish: the CLI bundle imported `bun`; the routingAffinity inventory count). The other 20 fail at the base commit or are listed there: AgentMail webhooks 8, realtime transport 7, GitLab event names 2, Slack config reload 1 (load), `initTelemetry` activation funnel 1 (fails alone at the base commit, `pg-base` worktree, part 6). `e2e:ui`: not re-run in part 6. |
| 17 | `bun run docs:openapi` | part 6 | diff adds only `dialect` on the db-query response (an engine field) |
| 18 | `bun run test:storage` | part 7, head `243a93a9e` | **pass**: SQLite 398/0, Postgres 448/0 (new: isolation test) |
| 21, 22 | bench report; stress scenarios | part 8, head `74403ae87` | **pass**: seeded bench writes p95 per route group and retry rate per site; `stress-poll-claim` and `stress-task-finish` show 0 exhausted retries and 0 5xx on Postgres. Sites above 5%: see D7 section. |
| 10 | base-commit SQLite file starts on the branch | part 9, head `f0480cc9a` | **pass on both engines** (`upgrade-base-db`; on Postgres through db-copy) |
| 19 | CLI copy command | part 9, head `f0480cc9a` | **pass**: `agent-swarm db-copy`; manual copy of a booted SQLite file: 140 tables, 15,310 rows, every count and checksum equal; `packages/storage-postgres/test/data-copy.test.ts` 4/4 |
| 20 | copy scenario with GET comparison | part 9, head `c9121c554` | **pass** (`data-copy`, `--only`, on both engine runs) |
| 23 to 26 | CI, docs, replica blockers, PR | | not done (M7). |

## Failures at the base commit

- `bun run e2e:strict` at the base commit (run 2026-11-20, 16 min 40 s, log kept outside the repo): **exit 1**. 215 scenarios pass, 0 fail, 1 flaky (`model-group-resolution`: first attempt 400 `model-group-unavailable`, passed on rerun). The strict gate fails on coverage only: `state task-statuses: 1 value(s) the suite never produced: in_progress` (task-engine 98.4%). This failure exists before any change on the branch.
- `bun run test:root -- --parallel=4` at the base commit: exit 1, 22,666-class pass count, about 45 failures in this container (AgentMail webhooks 8, boot retro-sweep 7, worker token 4, user roles 4, realtime transport 7, GitLab event names 2, others). At M1 head (no `src/` change since the base; `git diff 99d7de13a -- src` is empty): 22,666 pass, 39 fail, the same set minus the realtime-transport tests that passed this time, plus two 5 s timeouts (`routing-reason-inventory` passes alone in 4.8 s, so it is a load timeout). The host load average reached 39 on 8 cores during these runs.
- `bunx biome check scripts/e2e`: `scripts/e2e/scenarios/slack-inbound-gates.ts:13` unused variable `ALICE` at the base commit.

## M0 results

### Recount of section 6 (step 3)

Command: `bun thoughts/taras/research/spikes/m0-counts.ts` (output: `thoughts/taras/research/spikes/m0-counts.out.txt`). Regex counts over non-test `src/` files, excluding migrations. They are upper bounds, not parsed SQL.

| Hazard | Brief | Measured |
|---|---|---|
| `getDbClient()` call sites | ~1,460 in ~200 files | 1,480 in 207 files |
| `.transaction(` sites | ~290 | 291 in 127 files |
| Statements (string that starts with SELECT/INSERT/UPDATE/DELETE/WITH) | 1,800-2,200 | 2,454 string starts in 344 files (includes non-SQL strings such as log text; upper bound) |
| WHERE-fragment builders (`conditions/where/clauses/filters.push(`) | ~180 | 178 in 19 files |
| IN-list expansions (`map(() => "?")`) | ~140 | 107 in 47 files (other expansion styles exist, not counted) |
| `strftime(` / `datetime('now'` | (idiom) | 79 in 16 files / 44 in 17 files |
| `IS NOT <value>` (uppercase, not NULL, not DISTINCT) | 231 | 21 in 11 files |
| `GLOB` | 41 | 45 in 18 files |
| `rowid` | 117 | 184 in 33 files |
| `INSERT OR IGNORE/REPLACE` | 24 | 24 in 12 files |
| `changes()` / `.changes` / `lastInsertRowid` | 153 | 157 in 48 files |
| `json_each` / `json_extract` | 19 files / 62 | 34 in 19 files / 65 in 22 files |
| PRAGMA | 28 | 28 in 6 files |
| `LIKE` | 111 | 132 in 35 files |
| scalar `MAX(a, b)` / `MIN(a, b)` | (named) | 3 in 2 files |
| `rowTo*` mappers / `JSON.parse` in those files | ~47 | 76 in 21 files / 92 |
| Sites that match SQLite error text | ~14 | 26 matches in 14 files |
| Seam allowlist (`check-async-db-seam.sh`) | 19 | 19 |
| `new Database(` openers in runtime code | 3 | 5 in 4 files |
| `bun:sqlite` importers (non-test src) | ~35 incl. scripts | 9 in 9 files (src only) |
| SQL in seed-scripts | ~280 lines | 555 lines with a SQL keyword (upper bound, includes prose) |
| Migration files / `CREATE TRIGGER` statements | 256 / 65 | 261 / 71 statements, 65 triggers at head |
| docs-site pages naming SQLite | 19 | 19 |

`getDbClient()` by directory: `src/be/db.ts` 425, `src/be/db/` 270 (39 files), `src/be/db-queries/` 81 (6), `src/http/` 70 (26), `src/be/memory/` 59 (15), `src/workflows/` 40 (12), `src/tools/` 23 (10), `src/apps/` 18 (6), `src/scheduler/` 11 (3), `src/heartbeat/` 5 (1).

Head schema (from `ts-columns.ts`, migrations applied to an empty file): 158 tables (15 FTS shadow), 418 indexes, 65 triggers, 1 view, 1,824 columns. Declared types: TEXT 1,521, INTEGER 212, REAL 36, none 31, DATETIME 9, BLOB 8, JSONB 7. `memory_fts` (FTS5) and `memory_vec` (sqlite-vec) are not in the migration chain: `src/be/memory/providers/sqlite-store.ts:237` and `:402` create them at run time.

Finding for D8: the schema mixes camelCase columns (`createdAt`) and snake_case columns (`created_at`, `kv_entries`, `codex_oauth_device_flows`). Quoting each identifier with an uppercase letter covers both.

### Driver spike (step 5)

Command: `PG_URL=postgres://postgres@127.0.0.1:55432/postgres bun thoughts/taras/research/spikes/bun-sql-spike.ts`. Output: `thoughts/taras/research/spikes/bun-sql-spike.out.txt`. Result: 16 of 16 pass on Bun 1.4.4 + Postgres 16.15 + pgvector 0.6.0. The same file compiled with `bun build --compile` also passes 16 of 16.

**Driver choice: `Bun.SQL` (D14 holds). The postgres.js fallback is not needed.**

Facts the client and the codec must handle:

- Pool runs queries in parallel (8 queries that each sleep 0.3 s finish in 303 ms).
- `connection: { default_transaction_isolation: "serializable", TimeZone: "UTC" }` sets the session default (D6).
- `sql.begin` pins one backend for the callback, also with parallel calls inside.
- `tx.savepoint` after a unique violation (errno `23505`) keeps the outer transaction usable. Without a savepoint the next statement fails with `25P02`.
- Errors carry the SQLSTATE in `errno` (`23505`, `23503`, `23514`, `23502`, `40001`, `22021`, `25P02`). `code` is always `ERR_POSTGRES_SERVER_ERROR`. Typed errors key on `errno`.
- Two concurrent read-then-write SERIALIZABLE transactions produce `40001`.
- `bigint`, `bigserial` and `numeric` return as strings. `timestamptz` returns as `Date`. `bytea` returns as `Buffer`. `jsonb` returns parsed.
- **Hazard (new):** a JS string bound to `$1::jsonb` is sent as a JSON string, so the stored value is a jsonb *string* (`jsonb_typeof` = `string`). Bind JSON text as `$1::text::jsonb`, or bind the object. The dialect helper must emit the `::text::jsonb` form. The contract suite must test it.
- NUL byte in `text` fails with `22021` (D11 must report it).
- pgvector `<=>` order works. Session advisory lock on a reserved connection blocks a second session (D16 works).

### Transaction sites (step 6)

Command: `bun thoughts/taras/research/spikes/tx-sites.ts > thoughts/taras/research/2026-11-20-tx-sites.md`. 291 sites. 12 callbacks name a side-effect candidate in their own body. 12 have a catch block, 2 of them near constraint text. The scan does not follow calls into other functions: transitive side effects are not found. M2 step 6 (`check:tx-callbacks`) and `--tx-replay` close that gap by execution.

### Timestamp formats (step 7)

Command: `bun thoughts/taras/research/spikes/ts-columns.ts > thoughts/taras/research/2026-11-20-timestamp-columns.md`.

- 44 columns default to `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (ISO with `Z`).
- 62 columns default to `datetime('now')` or `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`).
- 6 columns hold epoch milliseconds as INTEGER (`unixepoch('subsec') * 1000`): `kv_entries`, `codex_oauth_device_flows`, `model_catalog_overlay`. On Postgres these stay `bigint`, not `timestamptz`.
- 190 timestamp-named columns have no default (the app writes them, mostly `toISOString()`).
- Invalid timestamps in real data: not measured. No copy of production data was supplied. The step is conditional in the brief, so this is not a STOP-ASK.

### Repository domain map (step 8)

Input (generated): `thoughts/taras/research/2026-11-20-domain-map-input.md` lists the `src/be/db.ts` sections with line ranges and, for each table, the files whose SQL names it.

| Domain | Tables | Current files |
|---|---|---|
| tasks | `agent_tasks`, `agent_tasks_fts*`, `task_attachments`, `task_citations`, `task_context_snapshots`, `task_idempotency_keys`, `task_steering_messages`, `task_templates`, `task_ui_action_runs`, `task_ui_specs`, `deferred_task_waits`, `deferred_task_wait_members`, `deferred_event_waits`, `routing_decisions`, `human_free_reclassify_queue`, `checklist_items` | `db.ts` L592-3818, L13050-13119; `db/tasks/`, `db/task-idempotency.ts`; `db-queries/task-artifacts.ts`; `be/checklist.ts` |
| agents | `agents`, `agent_log`, `agent_history`, `agent_mcp_servers`, `agent_skills`, `active_sessions`, `services`, `context_versions` | `db.ts` L572-591, L2235-2402, L3819-4042, L7244-7381; `db/agents.ts`, `db/active-sessions.ts`, `db/context-versions.ts` |
| messaging | `channels`, `channel_messages`, `channel_read_state`, `channel_activity_cursors`, `inbox_messages`, `inbox_item_state`, `agentmail_inbox_mappings` | `db.ts` L4043-4869, L5706-5881, L7157-7243, L12800-12914 |
| sessions and cost | `session_logs`, `session_costs`, `session_members`, `session_shares`, `session_summaries`, `session_summary_recompute`, `session_tokens`, `request_composition`, `budgets`, `budget_refusal_notifications`, `pricing`, `automation_savings_*` | `db.ts` L4870-5705, L11620-12512, L13120-13684; `db/session-*.ts`, `db/request-composition.ts`; `be/savings/` |
| schedules | `scheduled_tasks` | `db.ts` L5985-6542; `src/scheduler/` |
| config | `swarm_config`, `swarm_repos`, `api_key_status`, `seed_state` | `db.ts` L6543-7156; `db/config-secrets.ts`, `db/api-keys.ts`; `be/seed/state-db.ts` |
| workflows | `workflows`, `workflow_versions`, `workflow_runs`, `workflow_run_steps`, `workflow_run_definitions`, `workflow_idempotency_keys`, `wait_states`, `approval_requests` | `db.ts` L7584-8583, L9775-10496; `db/workflow*`, `db/workflows/`, `db/approvals.ts`; `src/workflows/` |
| pages, metrics, apps | `pages`, `page_versions`, `metrics`, `metric_versions`, `apps`, `app_versions`, `app_user_config`, `user_favorites`, `primitive_objects` | `db.ts` L8584-9240, L12915-13049; `db/page-*.ts`; `src/apps/`; `be/primitives/` |
| prompt templates | `prompt_templates`, `prompt_template_history` | `db.ts` L9241-9774 |
| skills | `skills`, `skill_files`, `skill_invocations`, `skills_fts*`, `skills_meta_fts*` | `db.ts` L10497-11619; `db/skill-*.ts` |
| users and RBAC | `users`, `user_external_ids`, `user_identity_events`, `user_merge_jobs`, `user_tokens`, `roles`, `role_permissions`, `principal_roles`, `permission_audit`, `connector_codes` | `db.ts` L12513-12799; `db/users/`, `db/user-references.ts` |
| memory | `agent_memory`, `agent_memory_edge`, `agent_memory_version`, `memory_link`, `memory_rating`, `memory_retrieval`, run-time `memory_fts`, `memory_vec` | `src/be/memory/` (15 files) |
| kv | `kv_entries` | `db.ts` L13823-14753; `db/kv-windows.ts` |
| scripts | `scripts`, `script_versions`, `script_runs`, `script_run_journal`, `script_run_sources`, `script_apis`, `script_connections`, `script_credential_bindings`, `script_embeddings` | `db/script-*.ts`; `be/scripts/` |
| integrations | `slack_*`, `chat_*`, `tracker_sync`, `tracker_agent_mapping`, `mcp_servers`, `mcp_event_subscriptions`, `oauth_*`, `codex_oauth_device_flows`, `agent_fs_object_webhooks`, `events` | `db-queries/` (mcp-oauth, mcp-servers, oauth, slack-inbound, tracker); `db/slack-*.ts`, `db/codex-oauth-device-flows.ts`; `be/events.ts` |
| models | `model_catalog`, `model_catalog_meta`, `model_catalog_overlay`, `model_groups`, `model_group_members`, `model_profiles`, `model_alias_resolutions`, `harness_model_support` | `db/model-*.ts` |
| extensions | `extensions`, `extension_versions`, `extension_files`, `extension_assets`, `extension_runs` | `be/extensions/` |
| runtime pools | `runtime_pools`, `runtime_instances`, `runtime_controllers`, `runtime_cache_releases` | `be/runtime-pools/` |
| assets and import | `asset_key_mappings`, `asset_key_history`, `import_items`, `import_pending_assignments` | `db.ts` L1492-1985 |

## M1 results

### Runner and ctx.db (steps 1 and 2)

- `bun run e2e --engine sqlite|postgres` (default sqlite). With `postgres`, `scripts/e2e/sut.ts` reads `E2E_POSTGRES_URL`, creates one new database per API boot (`e2e_<stamp>`), passes it as `DATABASE_URL`, and drops it at stop (kept with `--keep`).
- Guard: after boot, the runner reads `_migrations` from the per-run database. An API that ignores `DATABASE_URL` fails the run at boot instead of passing on the default engine. Verified: `E2E_POSTGRES_URL=... bun run e2e --engine postgres --only upgrade-base-db` fails today with `the API did not migrate the per-run database (relation "_migrations" does not exist)`, as expected before M3.
- `ctx.db` (`scripts/e2e/db.ts`): SQL goes through the `sql` tag (`?` on SQLite, `$n` on Postgres) with `sqlList` and `sqlIdent`. On Postgres a worker owns a `Bun.SQL` pool and the main thread blocks on `Atomics.wait`, so `ctx.db` stays synchronous and scenarios keep their shape. Each Postgres read runs in a `READ ONLY` transaction (a probe INSERT fails with `cannot execute INSERT in a read-only transaction`). Rows come back in the SQLite shape: bigint to number, boolean to 0/1, jsonb to text, timestamptz to ISO text. Per-column timestamp formats come from the storage codec in M3.
- Driver use in e2e stays in `scripts/e2e/db.ts` and its worker `scripts/e2e/db-postgres-worker.ts`.

### Edited scenarios (section 10 record)

All edits are "SQL portability and helper use". No assertion was removed or weakened.

- 105 scenario files: every `ctx.db.get/query(text, params)` became `ctx.db.get/query(sql\`...\`)` with mixed-case identifiers double-quoted. Tool: `scripts/codemods/e2e-portable-sql.ts` (author-time codemod, committed). 351 call sites converted by the tool, 7 by hand (dynamic table names via `sqlIdent`, IN lists via `sqlList`, helper signatures `dbCount`, `webhookTasks`, `countRows` now take a `SqlQuery`).
- `script-connections.ts`: imports the tag as `dbSql`, because a local variable is named `sql`.
- `coverage-manifest.json` state-surface queries `stepType` and `fsMode`: identifiers quoted (D8). Not an exclusion.

### New scenarios (steps 3 and 4)

All pass on SQLite. They form the strict flow `storage-engine-parity` in `coverage-manifest.json`, so a missing or failing one fails the strict run.

| Hazard | Scenarios |
|---|---|
| Full-text and vector search (D15) | `divergence-fulltext-search`, `divergence-vector-search` |
| Order: ties, NULL, text order, pages | `divergence-list-order`, `divergence-text-order` |
| LIKE case and wildcards | `divergence-like-case` |
| Timestamp formats | `divergence-timestamps` |
| JSON, flags, large integers | `divergence-values` |
| Error mapping (unique, FK, CHECK) | `divergence-error-mapping` |
| Concurrent claims (schedule occurrence, idempotency keys, kv incr) | `divergence-concurrent-schedule-claim` |
| Trigger groups (8) | `trigger-asset-keys`, `trigger-model-profiles`, `trigger-session-maintenance`, `trigger-fts-sync`, `trigger-chat-relay`, `trigger-immutability`, `trigger-rbac-default-role`, `trigger-cascades` |
| Retention | `divergence-retention` |
| db-query denial of the 7 tables | `divergence-db-query-denial` |
| Start on a base-commit database (check 10) | `upgrade-base-db` |
| Stress (check 22) | `stress-poll-claim` (24 workers, 60 tasks, zero 5xx, each task claimed once) |

Facts these scenarios pin, which the Postgres side must reproduce:

- Text order is byte order (`10, 9, B, Z, _x, a, é`): Postgres needs `COLLATE "C"` or a C-collation database.
- LIKE folds ASCII case only. `%` and `_` are live wildcards on mcp-servers and schedules filters; workflows `q` escapes them.
- Three timestamp text formats reach the API: ISO with ms and `Z`, `YYYY-MM-DD HH:MM:SS` (built-in roles, task templates), and the space format rewritten to `.000Z` (pages, metrics). Epoch-ms integers in KV, pricing, budgets.
- Error bodies: unique conflicts mostly map to 409 with a fixed code. Skills return 400 with the raw `UNIQUE constraint failed` text. MCP server FK violations return 400 `FOREIGN KEY constraint failed`. A skill PUT with a bad `scope` returns 500. The typed errors of M3 must give the same status and text. The raw engine text and the 500 are product defects; they are recorded here, not fixed (no behavior change before the engine work).
- Ties: memory chunks and pages break ties by insertion order only (`// tie order: insertion` in `divergence-list-order`). The repositories must add a total-order tiebreaker that gives the same order.
- A vector hit at cosine 0.108 passes the 0.1 floor (`divergence-vector-search`). The pgvector distance must keep that floor exactly.
- 14 of 65 triggers have no API path (inventory: `thoughts/taras/research/2026-11-20-trigger-groups.md`). The repository contract suite (`test:storage`, M2/M3) must cover them.
- `trg_users_default_role` is created at boot by `src/be/rbac-roles.ts`, not by a migration. The Postgres baseline must include it.

Not covered by M1 scenarios: age-based deletion in retention (the API cannot backdate rows); two schedulers racing (the scheduler runs in one process with a re-entry guard).

### Fixture for check 10

`scripts/e2e/fixtures/base-db.sqlite.gz` (2.0 MB, a VACUUMed file made by base commit `99d7de13a`) plus `base-db.json` (row ids and a throwaway encryption key for the one secret config row). Generator: `bun scripts/e2e/fixtures/make-base-db.ts <checkout of the base commit>`. `ctx.startFixtureSut("base-db")` boots a second API on it. On Postgres the fixture goes through the copy command, which arrives in M6. Until then `startFixtureSut` throws on Postgres with a pointer to M6.

## M2 results

### Packages (step 1, D4)

- `packages/storage` (`@desplega/storage`): the driver seam (`DbClient`, moved out of `src/be/db-client.ts`), the `sql` tag (`sql`, `sqlList`, `sqlIdent`, `sqlJoin`, `sqlWhere`, `dialectFragment`), the `Dialect` interface with its helpers (`nowIso`, `nowText`, `nowEpochMs`, `likeAsciiCi`, `greatestStrict`, `leastStrict`), `Capabilities`, typed errors, `SqlExecutor`, the `Storage` facade, and one repository contract + base class per domain under `src/repositories/`.
- `packages/storage-sqlite` (`@desplega/storage-sqlite`): the bun:sqlite client (moved with `git mv`; logging and event-loop accounting are injected through a `StatementObserver`, so the package never imports `src/`), the SQLite dialect, the `Sqlite*` overrides and `createSqliteStorage`.
- Composition root: `src/be/storage-root.ts` is the only `src/` file that imports an engine package. `src/be/storage.ts` exposes `getStorage()`. `src/be/db-client.ts` stays as a re-export shim for existing importers until they move.
- The `sql` tag renders `?` or `$n` from structure. No SQL text is rewritten at run time (section 4).

### Decision: where entity types live (D4 open point)

Rule: **repositories return row types declared in `@desplega/storage`, in the SQLite value shape** (flags 0/1, JSON as text, each timestamp in the text format its SQLite column stores, epoch-ms integers as numbers). **Entity types stay in `src/types.ts`; the `rowTo*` mappers stay in `src/`.** The Postgres repositories convert to that row shape at the repository boundary (the codec of M3). Reason: the mappers and the ~660 SQLite-bound unit tests keep working unchanged, the API responses stay byte-equal on both engines, and the packages need no zod or `src/` import. A mapper never parses a driver-parsed value, because the Postgres codec hands back text.

### Checks added

| # | Command | Result now |
|---|---|---|
| 11 | `bun run check:dep-graph` (now cruises `packages/storage*`) | pass, 0 errors. New rules: packages never import `src/`; `bun:sqlite` only in `packages/storage-sqlite` (plus the transitional `PENDING_SQLITE_IMPORTERS`, 9 entries, each with a reason; empty by end of M2/M4); a Postgres driver module only in `packages/storage-postgres`; engine packages only from the composition root; the contracts package imports no engine. Probe: a temporary file that broke each rule produced 3 errors. |
| 12 | `bun run check:storage-boundary` | pass with a shrinking pending list: `scripts/storage-checks/storage-boundary-pending.json`, seeded once with `--init` at 246 files / 2,193 sites (SQL literals by uppercase statement shape, plus imports of `DbClient`/`getDbClient`/`getDb`). Each entry names its domain. `--update` only shrinks it. Permanent exceptions with reasons: `src/be/sql-connections.ts` (user external databases for scripts, Bun.SQL to the user's own DB, never the swarm DB), `src/be/storage-root.ts` (composition root). The `.sql` migration files stay under `src/be/migrations` (section 4 forbids renaming them); the check reads code only. |
| 13 | `bun run check:sql-portability` | pass (48 sql templates). Rejects unquoted mixed-case identifiers in any `sql` template (D8) and 22 SQLite-only forms outside `packages/storage-sqlite`. Probe: an unquoted `createdAt` and a `rowid` in the base class both failed. |
| 15 | `bun run check:tx-callbacks` | pass (292 callbacks, including callbacks passed by name). Two rule sets: known side effects (one reasoned exception: `emitRunFinished`, it schedules through afterCommit itself), and writes to state declared outside the callback (assignment, `++`/`--`, `push`/`add`/`set`/`delete`/`splice`/`clear`). A write that the callback resets at its start may carry `// tx-replay-safe: <reason>`; the check prints each one (8 today, see "New allowlist, exclusion or quarantine entries"). |
| 18 | `bun run test:storage` | SQLite side passes (extensions contract, 8 tests). Postgres side arrives in M3. |

### --tx-replay (step 6)

`bun run e2e --tx-replay` sets `STORAGE_TX_REPLAY=1` on the SUT. The SQLite client runs each outermost transaction callback once inside a savepoint, rolls it back with its afterCommit/afterRollback hooks discarded, then runs it for real. The runner refuses a run whose API log lacks the replay banner. Sample run (extensions, divergence-error-mapping, divergence-concurrent-schedule-claim, stress-poll-claim): 4 of 4 pass.

### Domains moved

| Domain | State |
|---|---|
| extensions | moved (`src/be/extensions/db.ts`, the `extension_assets` SQL in `assets.ts`); its workflow/skill lookups move with those domains |
| models | moved (`src/be/db/model-*.ts`) |
| runtime pools | moved (`src/be/runtime-pools/`) |
| config | moved (`swarm_config`, `swarm_repos`, `api_key_status`, `seed_state` in `src/be/db.ts`); `src/be/import/seeders.ts` is mislabeled config in the pending list: its SQL is `import_items`, skills and workflows, and moves with those domains |
| agents | moved: agents, agent history, context versions, active sessions, agent log, services, installs, capacity and daily counts, `src/http/agents.ts` transactions |
| messaging | started: `src/http/inbox-state.ts` transaction goes through storage |
| schedules | started: `src/scheduler/scheduler.ts` transactions go through storage; `deferred-task-waits.ts` and `schedule-task.ts` hold tasks-domain SQL and move with tasks |
| users and RBAC | moved (part 4): repositories `users` and `rbac`. Left: `session_tokens` SQL in `src/be/users.ts` (sessions domain); `ensureRbacSeedsSynced` (boot path, creates `trg_users_default_role`); `src/be/db/users/references.ts` and `user-references.ts`, whose SQL text `src/tests/user-delete-perf.test.ts` imports for its query-plan check |
| integrations | moved (part 4): repositories `mcpServers`, `trackers`, `events`, `chat`, `oauth`, `slack`. Left: sites that read `agent_tasks` or `agent_mcp_servers` |
| workflows | moved (part 4): repository `workflows`, including approvals and wait states and the `db.ts` workflow functions. Left: `workflow-run-retention.ts` (its SQL text feeds an EXPLAIN test), task-table sites |
| scripts, pages/apps, skills, kv | moved (part 4): repositories `scripts`, `pages`, `skills`, `kv`. Left: `listScriptConnections` (sync by design), `SCRIPT_RUN_SELECT` used by `db.ts`, `agent_fs_object_webhooks` sites |
| boot path (step 7, partial) | part 4: the SQLite migration runner, the script-run source backfill, the connection PRAGMAs, the legacy `agent_tasks` CHECK rebuild, the profile-column backfill, the legacy OAuth and credential-blob backfills and the encrypted-secrets probe moved into `packages/storage-sqlite/src/boot/`; `src/` keeps the rules and thin delegates. The asset key audit reads through a new `assets` repository; the boot scrub sweep through a new `maintenance` repository |

### Strict suite with --tx-replay on SQLite (M2 step 6)

Run 1 (head `a7d0a8482`, `bun run e2e:strict --tx-replay`): exit 1. 231 passed, 5 failed, 1 flaky (`model-group-resolution`, pre-existing). The 5 failures were real replay defects, each fixed and its scenario re-run alone with `--tx-replay` (pass):

- `core-agent-profile`: `updateAgentProfile` reported each compare-and-set conflict once per attempt (two events). Conflicts are now reported after commit.
- `knowledge-apps`: the app sync chunk kept `seen`/`mine`/warnings from the rolled-back attempt. Each chunk attempt now undoes them (`src/apps/sync.ts`, `ChunkState`).
- `workflow-approvals`, `workflow-engine-async-nodes`: the successor-walk hold of a rolled-back attempt leaked. Fixed with `onAttemptRollback`.
- `workflow-agent-task-crash-window`: `claimStep` (passed by name, so check 15 missed it) kept its executing-step mark across attempts; recovery read it as another walker's claim. Fixed with `onAttemptRollback`; check 15 now also scans a callback passed by name.

The other strict-gate errors of run 1 (11 routes, 17 MCP tools, 2 exclusions covered anyway) came from the failed scenarios, plus the pre-existing `in_progress` gap.

Run 2 (head `96c910d92`, `bun run e2e:strict --tx-replay`, log kept outside the repo): exit 1. 236 passed, 0 failed, 1 flaky (`model-group-resolution`, pre-existing, passed on rerun). The strict gate fails only on the pre-existing coverage gap `task-statuses: in_progress`, the same failure as the base commit. The runner confirmed the replay banner.

### Replay-unsafe callbacks found and fixed (M2 step 6)

The stronger check 15 found 44 writes to outer state in 20 files. Real defects under a replayed or retried attempt, now fixed:

- `updateAgentProfile`, `recordKeyUsage`: reassigned their own parameters; a Codex Pro plan report lost its raw identity on the second attempt.
- Runtime supervisor: an agent marked counted inside the callback skipped its retry and circuit update on the second attempt (the claim now happens before the transaction).
- `send-task`: the second attempt ran its dedup guards with the first attempt's bypass flag set.
- `store-progress`: a retry that returned early kept a learning promise whose afterCommit hook was discarded, so the call would wait forever.
- Approval config answers ran each config side effect twice; user-merge progress, re-embed counts and foreach fail-fast counted twice.
- `checkpointStep` kept stored context keys from the first attempt; a successor walk leaked the hold of the rolled-back attempt; the telemetry anchor cache took the value of an attempt that could roll back.

### Part 4 summary (2026-11-21)

Domain moves ran in parallel worktrees (one branch per domain group, merged into the feature branch after each group passed tsc, biome, test:storage, checks 12/13/15, dep-graph, its unit tests and its e2e scenarios with and without `--tx-replay`). New repositories: tasks, sessions, savings, users, rbac, workflows, scripts, pages, skills, kv, memory, schedules, messaging, promptTemplates, mcpServers, trackers, events, chat, oauth, slack, maintenance, assets, retention, agentFsWebhooks, improvements. `test:storage` (SQLite): 373 tests.

Pending list (check 12): 1,906 sites at the start of part 4, 298 now. What is left, by reason:
- 235 sites in 21 seeded db-query scripts (`src/be/seed-scripts/catalog/*`): M4 step 4.
- 5 sites in the own-handle db-query readers, 4 in the memory search worker and reader: M4 steps 4 and 5.
- 18 + 3 in the SQLite memory provider's synchronous start path (`sqlite-store.ts` creates `memory_fts`/`memory_vec` and computes health synchronously; `getHealth()` is synchronous in the `MemoryStore` interface). The Postgres memory provider is M4; the SQLite provider keeps these until then.
- 19 in `src/be/db.ts`: the synchronous prompt-template resolver (`resolvePromptTemplate`, used through `configureDbResolver` by 18 synchronous `resolveTemplate` call sites) and `autoEncryptLegacyPlaintextSecrets` (legacy SQLite boot repair).
- Small: `runtime.ts` (5, the SQLite handle owner), `seed-pricing.ts` (2, synchronous boot seed), `script-connections.ts` (2, `listScriptConnections` feeds default parameter expressions synchronously), `key-window-usage.ts` (2, SQL text pinned by an EXPLAIN test), `boot-seeds.ts` (1, handle identity), `storage.ts` (1), `scripts/typecheck.ts` (1, a false positive: a TypeScript declaration string).

Test-coupled SQL: some unit tests pin exact SQL text (EXPLAIN QUERY PLAN checks, text matches). Rule used: the text moves into the SQLite package, `src/` keeps its exported names as re-exports through the composition root, so each test still checks the text production runs. Where a test matches a fragment with an unquoted mixed-case identifier, the SQLite override writes that fragment raw (`new SqlQuery([...])`), outside check 13's view; SQLite-only by construction (tasks 2, memory 2, savings and session backfill 3, index hints 3, heartbeat 1, routing 1).

Strict suite on SQLite after the merges (run 1, head `add6484a8`): 235 passed, 1 failed, 2 flaky (`slack-lead-follow-up-card`, `model-group-resolution`, both pre-existing). Coverage 100% on every axis, `task-statuses` 10/10 (the `in_progress` gap is closed). Failures: `divergence-list-order` (the pages list tie order came back newest-first after a move; fixed to insertion order oldest-first, which the base commit returns, and the contract test that pinned the wrong order corrected), and `task-live-claim` belonged to no flow (new flow `live-task-claim`).

Check 16 gates at head `91dddd9b7`: `lint`, `lint:slop` (after fixing 11 `as unknown as` chains and 2 unused types left by merges), `tsc:check:tsc`, `check-db-boundary.sh`, `check-async-db-seam.sh`, `check-floating-promises.ts`, `check-promise-sinks.ts`, `check-audit-columns.sh`, `check:unit-test-allowlist`: pass. `test:root` and `e2e:ui`: not run yet in part 4.

### Part 5 summary (2026-11-21)

- The synchronous prompt-template resolver now goes through the async `promptTemplates` repository; `resolveTemplate()` is async and its callers await it. The SQLite start path seeds default templates synchronously through `packages/storage-sqlite` (`promptTemplateSqliteStart` in the composition root). The pricing seed, the key window usage read and the boot seeds moved into repositories. Pending list: 298 to 281 sites.
- Regression found by `test:root` and fixed: with the resolver async, an in-process session settled before the context-bound note rendered (6 tests in `claude-managed-adapter.test.ts`). Fix: with no DB resolver and no `{{@template[...]}}` reference, the resolver answers in the same tick, as before.
- Check 12 is not at 0. What is left, by owner: 235 sites in the seeded db-query scripts and 9 in the own-handle readers and the memory search worker (M4 steps 4 and 5); 21 in the SQLite memory provider (M4, its synchronous `getHealth()` and table bootstrap); 16 SQLite start-path and handle-owner sites (`db.ts` 7, `runtime.ts` 5, `script-connections.ts` 2, `storage.ts` 1) and 1 false positive (`scripts/typecheck.ts`, a TypeScript declaration string). The start-path sites move behind the composition root when M3 adds the Postgres start.

## M3 results

- Client, codec, typed errors, baseline 367, 56 of 65 trigger ports (the 9 FTS sync triggers have no Postgres table to write; full text runs on expression indexes, migration 368), Postgres runner with an advisory lock, checks 7, 9 and 14 (part 4 prep, merged in part 5).
- Every repository has a Postgres class with no `notOnPostgresYet` left. Ported in parallel worktrees (one per domain group), each group gated by both contract suites, `tsc`, `check:sql-portability` and biome.
- `bun run test:storage` now runs the contract suite on SQLite and then on Postgres (`test:storage:postgres`, needs `STORAGE_TEST_POSTGRES_URL`). Part 5 result after the M4 search merges: SQLite 396 pass / 0 fail, Postgres 431 pass / 0 fail.
- `check:schema-parity` broke when the read codec landed (every index read `unique=0` instead of `unique=false`). Fix: a `rawValues` client option, used only by catalog tools. Result: 0 unexplained, 164 allowlisted.
- Base-class SQL changed for Postgres, identical on SQLite (bun:sqlite binds `true`/`false` as 1/0; `CAST(text AS text)` is a no-op): `listAgentSkills` binds the flag in its UNION; the agent-token check compares `"scriptRun"` to `${false}`; task attachments write `capabilities` through `jsonText`; `listStalePinnedResumes` casts `tags` to text before LIKE.
- API start on Postgres (part 6, merged from `m3/pg-start`, head `7b5952e21`). Proof on an empty C-collation database: `DATABASE_URL=postgres://...` selects Postgres, the chain applies 367, 368 and 369, `GET /health` 200, `POST /api/tasks` 201 and `GET /api/tasks` returns the row, no SQLite file is written. `db-query` answers a clear error (no `dbQuery` capability yet, M4 step 4). D16: a second API on the same database exits 1 after 10 s with `another API process holds this Postgres database (session advisory lock ...)`.
- Defect found at the merge: the root `package.json` did not list `@desplega/storage-postgres`, so `tsc:check:tsc` failed (bun resolved it at run time). Both Dockerfiles also missed the three storage packages, which a frozen install needs. Fixed in `7b5952e21`. Docker is not in this container: the image build is not verified here; CI builds it.
- Gates at `7b5952e21`: `tsc:check:tsc`, `lint`, `check-db-boundary.sh`, `check-async-db-seam.sh` pass; `test:storage` SQLite 396/0, Postgres 431/0.

### Contract-test fixture edits (section 10 record)

- `skills` agent-skills test: `installedAt` fixture values `'x'`/`'y'` became real timestamps (a `timestamptz` column cannot hold `'x'`). No assertion reads them.
- `users` job-function test: the `"not json"` metadata fixture became NULL. Both engines answer `undefined` for it (SQLite `json_valid(NULL)` drops the row). Postgres `jsonb` cannot hold invalid JSON; the data copy (D11) reports such values instead.
- Postgres baseline tests read through the codec: a timestamp comes back as text (was a `Date`), and `_rowid` is read under an alias (the codec drops a column named `_rowid`).
- `migrations.test.ts`: the chain length is counted from the files (it was hard-coded to 1).
- Task FTS backfill test: its FTS5 `'delete-all'` setup became "set the mark to 0 before seeding" (same start state). Two assertions added, none removed.

## M4 results (part 5, steps 1 and 2)

- Full text on `tsvector` with GIN expression indexes, no shadow table, no trigger (migration 368 for skills and tasks, 369 for memory; each has a SQLite file with the same ordinal that states it is a no-op).
- Repository interfaces that took an FTS5 MATCH string now take the term list: `searchRankedSkills(terms)`, `searchFtsRows(terms)`. Each engine builds its own query; the SQLite text is unchanged.
- Vector search: `memory_vec` (pgvector, no fixed dimension, exact cosine k-NN, k first then filter, like sqlite-vec). Capped scoring runs in TypeScript with float32 arithmetic.
- D15 parity is asserted on a fixed corpus by contract tests on both engines: same id set, ranked FTS at least 4 of the first 5 equal (memory bm25 port: top 5 equal and in order), vectors in the same order.
- Not yet: M4 steps 3 (remaining `json_each`/`json_extract` sites outside repositories, if any), 4 (`db-query` on Postgres, D10, and the 235 seeded-script sites) and 5 (own-handle readers, the memory search worker, a Postgres `MemoryStore`).

## M4 results (part 6, steps 3 and 4)

- Step 3: no `json_each`/`json_extract` call is left outside the repositories and the seeded scripts (repository methods that use them are abstract in the base class with one override per engine). The seeded scripts are step 4.
- D10 reader (`packages/storage-postgres/src/query-reader.ts`): `DATABASE_QUERY_URL` opens a second pool after the migrations. The start probe refuses a role that is a superuser, has BYPASSRLS, CREATEROLE or CREATEDB, has CREATE on the database or a schema, owns any relation or schema, has any write privilege on a table, view or sequence (catalog), can read a denied table (table or column grant, catalog), is not refused a real `SELECT` on each denied table (SQLSTATE 42501), can read a view that reaches a denied table through any chain of views, can run a SECURITY DEFINER function, or is not refused a real `INSERT` (42501). A failed probe or no URL leaves `dbQuery` off; the log line names the reason (URL scrubbed). There is no `SET ROLE` and no SQL text filter.
- Each query: `BEGIN READ ONLY`, `SET LOCAL statement_timeout` to the remaining budget before each statement, `DECLARE ... NO SCROLL CURSOR FOR <user sql>`, `FETCH FORWARD maxRows`, `MOVE FORWARD ALL` (exact `total` without holding the rows). Only queries open a cursor; user SQL cannot lift the timeout of the running statement (test). Values go through the read codec (SQLite shape). 42501 on a denied table maps to the existing 400 message; 57014 to the 408 timeout. The concurrency cap of the bounded SQLite path also covers the reader.
- The tool description and the `db-query-guidance` skill follow the capabilities (dialect sections in the skill; the seeder keeps the active one). Every db-query response states `dialect` (the only OpenAPI change, an engine field, check 17).
- Proof: `packages/storage-postgres/test/query-reader.test.ts` (12 tests: probe refusals for superuser, table grant, column grant, view chain, write grant, SECURITY DEFINER, schema CREATE; queries, denial, writes refused, timeout). Live API: denied tables 400, `UPDATE` 400, `pg_sleep(20)` 408, a superuser URL leaves db-query off with the reason logged.
- E2E on Postgres: the runner creates each per-run database with `LC_COLLATE 'C' LC_CTYPE 'C'`, applies the migration chain, creates a reader role (SELECT on all tables, the 7 denied revoked) and passes `DATABASE_QUERY_URL`, the order the runbook gives an operator. The SUT guard now asserts a boot seed row (`seed_state`), since the schema exists before the SUT starts.
- CHECK failure text: SQLite reports the expression, Postgres the constraint name. The baseline generator now names each CHECK `<table>_check_<n>` and writes `check-messages.json` (SQLite source text by name); the error mapper uses it. Baseline regenerated (only the 153 CHECK lines changed); the generator keeps ordinal 367.

## M4 results (part 6, steps 4 and 5) and M5 progress

- Seeded db-query scripts (step 4): 17 scripts and 4 `.inline.ts` twins run on both engines. Portable text first (quoted identifiers, booleans, `$n` placeholders numbered in first-appearance order, JS-computed time cutoffs); one text per dialect where no portable form exists (`instr`/`strpos`, `group_concat`/`string_agg`, `json_extract`/`json_each`, `julianday`, `rowid`), chosen by the `dialect` field of each db_query response. A harness ran every Postgres statement of every script through the real reader and codec: 519 statements, 0 failures; outputs equal to SQLite except a time-dependent default and a raw `json_type` column the script does not read.
- Check 12 exemption (needs review): `check-storage-boundary.ts` gained `PERMANENT_DIRS` with `src/be/seed-scripts/catalog/` (reason on the line: read-only user SQL that db_query runs under the D10 reader role). Nothing now stops new SQLite-only SQL in a seeded script; the harness is the only proof.
- Own handles and memory (step 5): the SQLite db-query reader (bytecode denial, read-only handle, bounded child, worker pool) and the memory search worker moved into `packages/storage-sqlite`; the memory store is engine-neutral (`StorageMemoryStore`), reaching engine parts through `Storage.memoryIndexes` (SQLite: run-time `memory_fts`/`memory_vec`, worker pool; Postgres: migration 369, no worker). `getHealth()` is async. Memory store, search, edit, delete and health work over HTTP on Postgres. The worker starts from a Blob URL (checked in dev and a compiled binary; the Docker image is not built here).
- Check 12 now at 0 pending sites. Permanent entries, reason on each line: `src/be/db/runtime.ts` (engine-handle owner), `src/be/storage.ts` (builds Storage over the engine client), `src/be/scripts/typecheck.ts` (SDK type text with example SQL in comments, not SQL).
- Postgres fixes from the first Postgres strict runs (each with a contract test or a scenario that failed before):
  - A 40001 that a callback caught still aborted the transaction; COMMIT then failed with 25P02 (concurrent agent registration answered 500). The client records a retryable SQLSTATE hit by any statement or savepoint and retries the whole callback.
  - A single statement outside a transaction retries on 40001/40P01 (deviation, needs review: D6 names transactions only; such a statement is its own transaction and changed nothing when it lost).
  - Retry budget 16 attempts, backoff cap 1 s (was 8 / 250 ms): `stress-poll-claim` went from 5 exhausted retries to 0.
  - Foreign keys are `DEFERRABLE INITIALLY IMMEDIATE`, so `SET CONSTRAINTS ALL DEFERRED` matches SQLite's `PRAGMA defer_foreign_keys` (connection with a managed binding failed).
  - CHECK failures carry SQLite's text (named constraints + `check-messages.json`).
  - Moved off raw SQLite text in `db.ts`: the session list page, the session count, the attribution report, user deletion's reference rewrite.
  - Asset summary union: new dialect helper `isoTimestampText`.
  - Keyed workflow create: a loser that hits the winner's unique name replays the accepted operation.
  - db-query refuses a non-query with the read-only error on Postgres too.
- Scenario edits (section 10, SQL portability and helper use, no assertion change): `core-task-tools`, `core-telemetry`, `platform-secret-egress` bind `$n` (and `CAST($n AS text)` for an untyped select-list parameter); `script-run-storage` asks `ctx.db.reclaimsFreeSpace()` (SQLite auto_vacuum = 2, Postgres autovacuum on); `core-session-data` and `workflow-agent-task-crash-window` order by `${insertionOrder}` (rowid / `_rowid`).
- Bench (check 21 tooling): `bun run e2e:bench --engine postgres [--only ...]` runs the suite on both engines and writes p95 per route group plus a per-site retry table (`STORAGE_TX_STATS_FILE`, bench only). Stress result (stress-poll-claim + divergence-concurrent-schedule-claim, part 6): 952 transactions, 247 retried, 0 exhausted; sites above 5%: `src/http/poll.ts:802` (poll write pass, 92%), `src/http/tasks.ts:2028` (88%), `src/http/tasks.ts:1381` (90%), `src/scheduler/scheduler.ts:362`.
- Postgres strict runs (part 6): run 1 (head `a94edbdad`) and run 2 (head `16631956a`) both hit the run timeout before the end (50 and 65 min; the Postgres suite runs slower and retries); run 2 reached 196 passed / 54 failed attempts. Every failure group from those runs that is fixed above passed again with `--only` on Postgres afterwards. A full Postgres strict run on the current head has not been done.

## D7 opt-down: poll claim applied, task creation still open (Daniel, 2026-11-21)

Daniel chose `skip_locked_first`: apply READ COMMITTED + `FOR UPDATE SKIP LOCKED` to the poll claim, re-measure on a larger seeded database, and stop and ask if a rate stays above 5%.

Applied (part 7, commit `243a93a9e`): the poll write pass (`src/http/poll.ts`) runs with `transaction(..., { isolation: "read committed" })`, reason in the code. Locks that keep the old invariants: the agent row `FOR UPDATE` as the first statement (one write pass per agent: capacity, offers, pending tasks, mentions, runtime rows), the offered or pending task row `FOR UPDATE` before its claim (the pending path re-checks status and assignee after the lock), and the pool claim `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) AND status = 'unassigned'`. New seams: `TransactionOptions.isolation` (SQLite ignores it) and the dialect's `forUpdate` / `forUpdateSkipLocked` (empty on SQLite). Stress scenario: `stress-poll-claim` (one winner per task, maxTasks never exceeded).

Measurement: `E2E_POSTGRES_SEED_SQL=scripts/e2e/fixtures/postgres-bench-seed.sql bun run e2e:bench --engine postgres --only stress-poll-claim,divergence-concurrent-schedule-claim` (300 agents and 60,000 finished tasks seeded before boot). Before = `05c0e94e1`, after = `243a93a9e`, same seed, same host.

| Site | Before (seeded) | After (seeded) |
| --- | --- | --- |
| Poll write pass (`poll.ts:802` -> `:822`) | 63 of 72, 87.5% | 0 of 90, 0.0% |
| Task finish, `POST /api/tasks/{id}/finish` (`tasks.ts:2028`) | 52 of 60, 86.7% | 43 of 60, 71.7% |
| Keyed task creation, `POST /api/tasks` with an idempotency key (`tasks.ts:1381`) | 9 of 10, 90.0% | 9 of 10, 90.0% |
| Scheduler (`scheduler.ts:297`) | 90 of 101, 89.1% | 80 of 91, 87.9% |
| Agent registration (`agents.ts:758`) | 18 of 27, 66.7% | 16 of 27, 59.3% |
| KV (`kv.ts:663`) | 18 of 20, 90.0% | 18 of 20, 90.0% |
| Workflow engine (`engine.ts:350`) | 9 of 10, 90.0% | 9 of 10, 90.0% |

Exhausted retries: 0 before and after. Both scenarios pass on both engines. Correction to part 6: `tasks.ts:2028` is the task finish transaction, not task creation. Task finish and keyed task creation stay above 5%: STOP-ASK raised in part 7 (no other retry change applied without Daniel).

### Part 8: task finish applied, keyed creation kept (Daniel, 2026-11-21)

Daniel chose `apply_fix` for task finish and `keep_strict` for keyed task creation.

Applied (commit `74403ae87`): `POST /api/tasks/{id}/finish` (`src/http/tasks.ts`) runs with `transaction(..., { isolation: "read committed" })`, reason in the code. Locks, in the poll write pass order: the caller's agent row `FOR UPDATE` (the capacity count and the agent status write see every committed finish of that agent, and never run beside its own poll claim), then the task row `FOR UPDATE` (one finish per task; the terminal result guard reads the locked row). Every status write keeps its `status NOT IN terminal` guard. Dependents that the cascade fails are written through that guard too.

New stress scenario `stress-task-finish` (flow `storage-engine-parity`): 12 workers with `maxTasks` 4, 48 running tasks, each finished twice in one tick with different text; the first task of each worker fails and has a dependent. Asserts: no 5xx, exactly one 200 and one 409 per task, the stored text is the winner's, one terminal status log per task, each dependent `failed`/`cascade`, every worker `idle` at the end. Passes on SQLite and Postgres. With the agent lock removed it fails on Postgres (a worker ends `busy` with no task running), so the scenario guards the lock.

Measurement: same command, seed and host as part 7. Before = `bc73e306e`, after = `74403ae87`.

| Site | Before (seeded) | After (seeded) |
| --- | --- | --- |
| Task finish, `POST /api/tasks/{id}/finish` (`tasks.ts:2028` -> `:2037`) | 43 of 60, 71.7% | 0 of 60, 0.0% |
| Poll write pass (`poll.ts:822`) | 0 of 90, 0.0% | 0 of 88, 0.0% |
| Keyed task creation (`tasks.ts:1381`) | 9 of 10, 90.0% | 9 of 10, 90.0% (accepted exception) |
| Scheduler manual run (`scheduler.ts:297`) | 80 of 91, 87.9% | 91 of 101, 90.1% |
| Agent registration (`agents.ts:758`) | 16 of 27, 59.3% | 16 of 27, 59.3% |
| KV increment (`kv.ts:663`) | 18 of 20, 90.0% | 17 of 20, 85.0% |
| Keyed workflow creation (`engine.ts:350`) | 9 of 10, 90.0% | 9 of 10, 90.0% |

1,616 transactions, 142 retried, 0 exhausted. Both scenarios pass on both engines.

Accepted exception to the 5% target: keyed creation stays SERIALIZABLE; 90% retry rate comes from a scenario that races one key on purpose; approved by Daniel 2026-11-21.

Accepted exceptions (Daniel, 2026-11-21, part 9; no code change on these paths):

- Run-now on one schedule (`scheduler.ts:297`, 90.1%), increments of one KV key (`kv.ts:663`, 85.0%), one workflow idempotency key (`engine.ts:350`, 90.0%): the scenario fires 10 identical requests at one row on purpose; exhausted retries 0, 5xx 0; approved by Daniel 2026-11-21.
- Agent registration (`agents.ts:758`): 25 agents registering at once, 59.3% retry; runs once per worker start; a fix needs a new lock design; exhausted retries 0, 5xx 0; approved by Daniel 2026-11-21.

With these and the keyed-creation exception, the retry-rate part of check 21 passes with recorded exceptions.

### Part 10: unkeyed task creation fixed (Daniel, 2026-11-21)

Daniel chose `fix` for unkeyed task creation (`POST /api/tasks` with no idempotency key, 58.3% in part 9): the task-finish mechanism, READ COMMITTED with explicit row locks.

Applied (commit `7084a65ef`): the REST create passes `{ readCommitted: true }` to `createTaskExtended` (`src/be/db.ts`); its INSERT transaction then runs with `isolation: "read committed"` when it is the outermost transaction. Reason in the code. What SERIALIZABLE guarded, and how each holds:

- Parent key re-read (a chain move can commit between the parent read and the INSERT): the parent row is locked `FOR UPDATE` before the read, so an in-flight move commits first.
- Linear tracker dedup (`task:trackers:linear:` contextKey) and the workflow step check: no row to lock. A create that needs either stays SERIALIZABLE (same transaction, same code).
- Routing snapshot and human-free class: read-only inputs, no invariant.

New scenarios (flow `storage-engine-parity`): `stress-task-create` (12 workers, 60 unkeyed creates in one tick, 24 of them children of one keyed parent; asserts no 5xx, 60 distinct 201s, each child has the parent's key and id, one create log per task) and `divergence-tracker-dedup` (6 creates on one tracker key make one task). With the tracker split removed, `divergence-tracker-dedup` fails on Postgres 3 of 3 (6 tasks made), so it guards the split. Both pass on both engines.

Measurement: same seed and host as parts 7 to 9, bench list plus `stress-task-create`. Before = `c51a18c64` with the new scenario file, after = `7084a65ef`. Report: agent-fs `shared/swarm-postgres/bench-2026-11-21-part10.md`.

| Site | Before (seeded) | After (seeded) |
| --- | --- | --- |
| Unkeyed task creation (`tasks.ts:1388`) | 83 of 121, 68.6% (481 retries) | 0 of 121, 0.0% |
| Task finish (`tasks.ts:2037` -> `:2039`) | 0 of 156 | 0 of 156 |
| Keyed task creation (`tasks.ts:1381`, accepted) | 9 of 10, 90.0% | 9 of 10, 90.0% |
| Schedule run-now (`scheduler.ts:297`, accepted) | 90 of 101, 89.1% | 99 of 111, 89.2% |
| Agent registration (`agents.ts:758`, accepted) | 35 of 51, 68.6% | 38 of 51, 74.5% |
| KV increment (`kv.ts:663`, accepted) | 18 of 20, 90.0% | 18 of 20, 90.0% |
| Keyed workflow (`engine.ts:350`, accepted) | 9 of 10, 90.0% | 9 of 10, 90.0% |
| Schedule occurrence claim (`scheduler.ts:362`) | 1 of 1 | 0 of 1 |

After: 1,923 transactions, 173 retried, 0 exhausted, 0 5xx. Acceptance (at or below 5%, exhausted 0, 5xx 0) met. The schedule occurrence claim ran once per run (one retry in the before run, none after); no new site above 5% on the head.

## M6 results (part 9)

Command: `agent-swarm db-copy --from <sqlite file> --to <postgres url> [--json <report>]` (defaults `DATABASE_PATH`, `DATABASE_URL`). Code: `packages/storage-sqlite/src/copy-source.ts` (read-only source), `packages/storage-postgres/src/data-copy.ts` (target), contract types in `packages/storage/src/data-copy.ts`, wiring in the composition root, CLI front end `src/be/data-copy-command.ts`.

D11 steps, as built:

1. The SQLite file opens with `readonly: true` and `PRAGMA query_only`. Integers read as bigint; text reads as its bytes (`CAST(x AS BLOB)`), so invalid UTF-8 is visible.
2. A target with rows is refused. Exception: tables the Postgres chain itself inserts into (`pricing`, `roles`, `task_templates` and four more); the copy replaces their rows with the source's. A target with no table gets the chain first. A source or target at another migration head is refused with the runbook step (start this build on the SQLite file once, stop, copy). The copy also takes the one-process lock (D16), so it refuses a database an API runs on.
3. `ALTER TABLE ... DISABLE TRIGGER USER` on each table with a user trigger, inside the copy transaction; `ENABLE` after `SET CONSTRAINTS ALL IMMEDIATE` (ALTER TABLE refuses pending trigger events). Foreign keys are deferred during the copy and checked before COMMIT.
4. Conversion by the target column type (`format_type`/`typname`): boolean from 0/1, bigint, float, jsonb, timestamptz (both SQLite text formats; text with no zone is UTC), bytea, text. Every parameter binds as `$n::text::<type>` (a direct string bind into jsonb stores a JSON string, found by the checksum on the first run).
5. Refused values are reported per table, column and row (NUL in text or JSON, invalid UTF-8, invalid timestamp, flag not 0/1, invalid JSON, NULL in NOT NULL, unknown type). Any refusal rolls back the whole copy: nothing is written. Decision inside my authority: no "replace and continue" mode; the operator fixes source rows first (runbook).
6. Full text needs no rebuild (expression GIN indexes, migration 368/369). `memory_vec` is rebuilt from the copied `agent_memory.embedding` values with `EMBEDDING_DIMENSIONS` floats. FTS5 and sqlite-vec virtual and shadow tables are skipped by name (`agent_tasks_fts_state` is data and is copied).
7. Each identity column restarts past its highest copied value (`setval`). `rowid` goes into `_rowid`.
8. Per table: row count and an order-free checksum (sorted SHA-1 of each row's normalized values: booleans t/f, integers as bigint text, floats by value, JSON canonical with sorted keys, timestamps as epoch ms, bytea as hex). The target side reads Postgres text forms and normalizes the same way.
9. Exit 1 on any refusal, refused target, constraint failure or count/checksum difference; exit 2 on bad arguments.

Encrypted secrets copy as ciphertext; the target API needs the same encryption key file (the scenario proves a secret decrypts on the copy).

Proof:
- Manual: a SQLite file from a booted API, 140 tables, 15,310 rows, every count and checksum equal; a second copy into it refused (rows); a file with a NUL, invalid UTF-8 and an invalid timestamp refused with the three rows named, nothing written.
- `packages/storage-postgres/test/data-copy.test.ts` (4 tests, in `test:storage`): every type, rowid, seeded-row replacement, sequence restart, trigger back on; 7 refusal kinds; a foreign key failure rolls back; occupied target and migration-head refusals.
- Scenario `data-copy` (check 20, new, order 9010): fills a source API (agent, 3 tasks with Unicode, tags, schedule, plain and secret config, KV JSON, memory, page), copies, boots a Postgres API on the copy and compares 9 GET routes by strict deep-equal plus the KV value text; writes a new task on the copy; a second copy while the target API runs exits 1. The only normalization: each API's own origin in links (a page `api_url`) becomes a placeholder, because the two APIs listen on different ports.
- `upgrade-base-db` (check 10) on Postgres: the harness boots this build on the fixture file (SQLite chain upgrade), stops it, runs db-copy into the SUT database, boots the SUT with the fixture key. Passes on both engines.

Decision inside my authority: `data-copy` needs `E2E_POSTGRES_URL` in every run, including the SQLite run, so the scenario list stays the same on both engines (check 3). CI gives the SQLite e2e job a Postgres service too (M7).

## M7 results (part 9)

- CI (check 23): merge-gate jobs `e2e-postgres-shard` (4 shards, `--engine postgres`) and `e2e-postgres` (strict merge), `storage-checks` (checks 7, 12, 13, 14, 15, 18; check 11 stays in lint-and-typecheck), all with a `pgvector/pgvector:pg16` service; the SQLite `e2e-contract-shard` jobs get the same service for `data-copy`. Merge Gate needs all three. The helm workflow runs `scripts/check-chart-postgres.sh` (chart tests).
- Chart: `database.url` / `database.queryUrl` / `database.existingSecret`; a `<release>-database` Secret; DATABASE_URL and DATABASE_QUERY_URL from it; Litestream sidecar, ConfigMap and Secret off on Postgres; the `api.replicas == 1` guard kept (message names both engines).
- Compose overlay `docker-compose.postgres.yml`; `DEPLOYMENT.md` section; docs-site guide `guides/postgres.mdx`, CLI, environment-variable and Kubernetes pages; `runbooks/postgres.md` with the production cutover and rollback; `CLAUDE.md` engine wording and a pointer to the rules.
- Replica blockers (check 25): `thoughts/taras/research/2026-11-20-replica-blockers.md`, 114 items with file and line (buses 11, locks 41, caches 15, timers 30, single-owner connections 8, local files 5, other 4). Hardest: workflow execution ownership in process memory, realtime rooms, boot-time orphan resets, config reload into `process.env`.
- Fork `main` merged into the branch (25 commits, D18). Conflicts: `package.json` (`check:dep-graph` keeps the storage packages and adds `packages/agent-swarm-sdk`), `src/be/db/slack-card-groups.ts` (main dropped `lastSectionAt`; the read stays on the slack repository).

Postgres defects found by the full 4-shard strict runs and fixed (each with the scenario that failed):

- Pool claim at READ COMMITTED (D7 site): when concurrent polls took every candidate of one list, the poll returned no task while free tasks remained (SERIALIZABLE used to retry and re-read). The claim loop now reads the pool again, up to 5 lists (`src/http/poll.ts`). Failed: `model-harness-guard` after `poll-concurrent-claim`. Not a retry change: the isolation and locks are unchanged.
- Unique violation on an expression index mapped to garbage text; it now gives SQLite's `UNIQUE constraint failed: index '<name>'` (`packages/storage-postgres/src/errors.ts`, contract test in `client.test.ts`). Failed: `divergence-error-mapping`.

Scenario edits (section 10, SQL portability and helper use, no assertion change): `platform-chat-sdk-rocketchat` (GLOB to a `substr` prefix test), `platform-webhooks` and `slack-thread-one-card` (lines from main: `?` placeholders with a params array that `ctx.db.get` ignores, and unquoted camelCase; now the `sql` tag with quoted identifiers; on SQLite they had run with unbound parameters).

## Part 9 final check runs (head `52bf8352c`)

| # | Check | Result |
|---|---|---|
| 1 | strict suite on SQLite (4 shards + strict merge) | **pass**: merge exit 0, 240 passed, 0 failed, 2 flaky (`extensions` timeout under load, `model-group-resolution`, flaky at the base) |
| 2 | strict suite on Postgres (4 shards + strict merge) | **fail**: 240 passed, 1 failed, 1 flaky. `github-emulate-flows` failed both attempts ("no task for the maintainer's comment 2"); it passes alone 3 of 3 and passed in the full run at `0145bc54c`; it also failed once in a part 6 run. The rerun API log shows webhook 401s (signature) around a SUT restart. Cause not found. |
| 3 | same scenario list | **pass** by construction: one list, no engine branch; `data-copy` runs in every run |
| 4 | `--tx-replay` on Postgres (4 shards + strict merge) | **pass** at `0145bc54c`: merge exit 0, 238 passed, 4 flaky (`workflow-predicate-compat`, fixed since: jsonb key order; `knowledge-apps-large-model` timeout; `model-group-resolution`; `stress-task-finish` one ECONNRESET) |
| 5 | divergence scenarios on Postgres | **pass** in the Postgres run (flow `storage-engine-parity` passes) |
| 6 | no new coverage exclusion | **pass**: the manifest diff since the base adds a flow and quotes two identifiers, no exclusion |
| 7, 9, 11 to 15 | parity, migration conflicts, dep-graph, boundary, portability, triggers, tx-callbacks | **pass** |
| 16 | existing gates | `lint`, `lint:slop`, `tsc:check:tsc`, db boundary, async seam, floating promises, promise sinks, audit columns, unit-test allowlist: **pass**. `test:root -- --parallel=4`: exit 1, 23,118 pass / 27 fail: 19 fail at the base (AgentMail 8, realtime transport 7, GitLab event names 2, Slack reload 1, initTelemetry 1), 8 are load timeouts (load average 46) whose 6 files pass alone 30/30, plus one hook timeout. `e2e:ui`: not run. |
| 17 | `docs:openapi` | **pass**: no diff; against main it adds only `dialect` |
| 18 | `test:storage` | **pass**: SQLite 398/0, Postgres 452/0 |
| 19, 20 | data copy | **pass** (M6) |
| 21 | bench report | report written (`bun run e2e:bench --engine postgres --only stress-poll-claim,divergence-concurrent-schedule-claim,stress-task-finish`, seeded 300 agents / 60,000 tasks); 1,840 transactions, 190 retried, 0 exhausted. **New site above 5%: unkeyed task creation `src/http/tasks.ts:1388`, 35 of 60, 58.3%** (first measured now: `stress-task-finish` joined the bench). STOP-ASK. Accepted exceptions this run: schedule run-now 90.1%, KV 90.0%, keyed task creation 90.0%, keyed workflow 90.0%, agent registration 71.8% (was 59.3%). Report: agent-fs `shared/swarm-postgres/bench-2026-11-21-part9.md`. |
| 22 | stress scenarios | **pass**: 0 exhausted retries, 0 5xx |
| 23 to 25 | CI, docs, replica blockers | **done** (M7) |
| 26 | PR | not opened: waiting on the STOP-ASK |

## Part 10: GitHub webhook flake on Postgres (investigated and fixed)

Daniel chose `investigate` (2026-11-21).

Cause: `/health` answers as soon as the server listens, but `initGitHub()` ran later in the listen callback, after the awaited telemetry and Slack startup (`src/http/index.ts`). A delivery in that gap is checked with no secret and gets 401; GitHub (and the emulator) do not redeliver. `github-emulate-flows` restarts the API and creates the issue and comments at once, so all three webhooks can land in the gap. The order is upstream code (unchanged since the base commit); the Postgres engine widens the gap, because the awaited startup reads are network round trips.

Evidence:

- Server log at the part 9 failure (rerun, restart 1): `GET /health → 200`, then three `POST /api/github/webhook → 401` ("Signature verification failed"), then `[Slack] Task watcher started`, then `[GitHub] Webhook handler initialized`. DB state at the failure: no `agent_tasks` row with `source = 'github'` for the repo; the webhooks never reached the handler.
- Probe (a temporary scenario, not committed): restart the API with a GitHub secret, then send a signed `ping` every 5 ms until it answers 200. Before the fix: Postgres 3 of 20 restarts got 3 or 4 401s (77 to 126 ms after `/health`); SQLite 0 of 15. After the fix: Postgres 0 of 30, SQLite 0 of 15.
- Full Postgres runs before the fix: run 1 (4 shards) passed, run 2 invalid (5 parallel boots hit the 60 s health timeout), run 3 passed plus 6 runs of the scenario alone under that load, all passed. The full-run failure did not reproduce in 2 valid runs; the probe reproduces the mechanism.

Fix (commit `216829ddf`, in this branch because the branch makes it fail): the GitHub, GitLab, Azure DevOps and Bitbucket webhook inits (synchronous env reads) run first in the listen callback, before any await. No scenario changed. Proof: the probe above; `github-emulate-flows`, `platform-webhooks`, `defer-wake-pr-merged` pass on both engines; strict full runs after the fix (below) pass `github-emulate-flows` every time.

Same class, not fixed (new, seen once): `linear-emulate-flows` failed its first attempt in one Postgres run (`linear authorize url: expected 200, got 500`), passed on rerun. `await initLinear()` writes the Linear `oauth_apps` row later in the same callback, after `/health` answers; the authorize route reads that row. Closing it needs `initLinear`/`initJira` before `listen`, a larger change to the start order. Left open; listed under "Open risks".

## Part 10 final check runs (code head `216829ddf`)

| # | Check | Result |
|---|---|---|
| 1 | strict suite on SQLite (4 shards + `merge.ts --strict`) | **pass**: 242 passed, 0 failed, 2 flaky (`slack-pre-task-create-block` reaction timeout, `model-group-resolution`, flaky at the base) |
| 2 | strict suite on Postgres, two full runs | **pass** both: 242 passed, 0 failed. Flaky: `model-group-resolution` (both), `linear-emulate-flows` (second run; see the webhook section). `github-emulate-flows` passed in both. |
| 3 | same scenario list | **pass** (one list; both engines ran 242) |
| 4 | `--tx-replay` on Postgres (4 shards + strict merge) | **pass**: 242 passed, 0 failed, 2 flaky (`model-group-resolution`, `linear-emulate-flows`) |
| 5 | divergence scenarios on Postgres | **pass** (flow `storage-engine-parity`, now with `stress-task-create` and `divergence-tracker-dedup`) |
| 6 | no new coverage exclusion | **pass**: the manifest diff adds two scenarios to a flow, no exclusion |
| 7 | schema parity | **pass**: 0 unexplained, 164 allowlisted |
| 9, 11 to 15 | migration conflicts, dep-graph, storage boundary, SQL portability, triggers, tx-callbacks | **pass** |
| 16 | existing gates | `lint`, `lint:slop`, `tsc:check:tsc`, db boundary, async seam, floating promises, promise sinks, audit columns, unit-test allowlist, test spawn: **pass**. `e2e:ui`: **pass** (294 passed, 79 skipped; first run in this work). `test:root -- --parallel=4` (with `env -u BOOT_SCRUB_MODE -u RBAC_ENABLED`): exit 1, 23,098 pass / 28 fail: 18 fail at the base (AgentMail 8, realtime transport 7, GitLab event names 2, initTelemetry 1); the other 10 are in 7 files that pass alone (inventories 3/3, Slack mode lifecycle 2/2, app shell 5/5, scripts-fs 16/16, savings rollup 22/22, agent-fs proxy 27/27, required-params migration 7/7). |
| 17 | `docs:openapi` | **pass**: no diff |
| 18 | `test:storage` | **pass**: SQLite 398/0, Postgres 452/0 |
| 21, 22 | bench, stress | **pass**: unkeyed task creation 0.0% (part 10 section); 0 exhausted, 0 5xx; only accepted exceptions above 5% |

## Decided: JSON key order in API responses (Daniel, 2026-11-21)

Was open: `jsonb` (D8) reorders object keys, so `divergence-values` (user metadata) and `platform-users` (the `profile_changed` event's before/after) failed on JSON text. Daniel chose (a), `accept_reorder`: keep `jsonb` and accept reordered keys. The two scenarios now compare the parsed value with a strict deep-equal (`Bun.deepEquals(..., true)`); every key and value is still asserted. Recorded under "Deviations" and "Edited scenarios". `kv_entries.value` is text and keeps its byte-order assertion.

## Decisions inside my authority

- Text search configurations (M4). Skills: `english` (SQLite uses the porter tokenizer). Tasks: `simple` (SQLite `agent_tasks_fts` is unicode61 without porter, so ids and numbers match exactly). Memory: `memory_english`, english with a snowball stemmer that keeps stop words (FTS5 indexes every word and the memory query ORs its terms). A SQL function turns ASCII and common Unicode punctuation into spaces before `to_tsvector`, so words split as unicode61 splits them; task text is cut at 100,000 characters (a 1.3 MB task otherwise fails to insert: a tsvector over 1 MB errors).

- `_rowid` surrogate (M3 prep). Every Postgres table that has a SQLite rowid gets `"_rowid" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL` with a unique index (133 tables); tables whose INTEGER PRIMARY KEY is the rowid use that key; `kv_entries` is WITHOUT ROWID. Reasons: session logs expose `rowid AS seq` in the API, `human_free_reclassify_queue` stores rowids, and about 140 repository ORDER BYs break ties on rowid. The data copy (M6) copies rowid into `_rowid` and resets the identity, so API values stay equal across engines. The read codec drops a result column named `_rowid` (SQLite's `SELECT *` never returns rowid). One parity-allowlist key covers the pattern.
- Postgres databases use the C collation and C character classes (`LC_COLLATE 'C' LC_CTYPE 'C'`): byte text order like SQLite, and ILIKE/lower()/upper() fold ASCII only, like SQLite's LIKE/lower()/upper(). The dialect's `likeAsciiCi` is `ILIKE ... ESCAPE` (with `ESCAPE ''` when the caller names none: Postgres escapes with a backslash by default, SQLite does not).
- Column classification (D8) is conservative: 239 + 16 timestamptz, 22 epoch-ms, 45 boolean, 83 jsonb, 136 bigint; 72 columns stay text with a reason (for example timestamp columns whose existing rows mix both formats: converting them would rewrite old rows' format in the copy). File: `src/be/migrations/postgres/column-types.json`, each entry with evidence.
- Writes into jsonb columns go through the `jsonText` dialect helper: a plain text bind into jsonb stores a JSON string (measured), so Postgres renders `CAST(? AS text)::jsonb`.
- D2: `SWARM_DATA_DIR` locates the encryption key file and the page-session secret; default = directory of `DATABASE_PATH` (same paths as before). `DATABASE_URL`, `DATABASE_QUERY_URL` and `SWARM_DATA_DIR` are reserved keys (deployment env only).

- Boot path (M2 step 7), part 4. The SQLite start stays synchronous and keeps its order of steps. Its SQLite-only statements (PRAGMAs, migration runner, legacy repairs) live in `packages/storage-sqlite/src/boot/` and are reached through the composition root. The one-time data repairs (migration-117 OAuth plaintext, the `SCRIPT_CREDENTIAL_BINDINGS` blob, script-run sources) exist only for upgraded SQLite files: a Postgres database starts from the baseline or from a copy of a SQLite file that already ran them, so they get no Postgres version. Engine-neutral start checks (asset key audit) are a fetch plus one pure evaluation: the SQLite start path runs the fetch synchronously with the same `sql` text rendered for SQLite, the route and the Postgres start (M3) run it through the async repository.
- `app_user_config` was moved by two parallel domain moves; the `users` repository copy is kept and the `pages` copy dropped.

- `onAttemptRollback` (M2 step 6). D6 discards the afterRollback hooks of an attempt that the client runs again. In-process state that an attempt sets up (the successor-walk hold, the executing-step mark) then leaked, and runs never finalized under `--tx-replay`. The storage client now has a third hook, `onAttemptRollback(fn)`: it runs synchronously when any attempt rolls back (replayed, retried or last) and is dropped on commit. It is only for undoing in-process state, never for a side effect; side effects stay in `afterCommit`/`afterRollback` as D6 says. The D6 rules for the two existing hooks are unchanged. The Postgres client (M3) must implement it.

- D4 entity types: decided in M2 (see "M2 results").
- Driver: `Bun.SQL` (spike above).

## Deviations

- Milestone order (part 5): M4 steps 1 and 2 (full text and vector search in the repositories) landed before M3 closed, because the contract suite (M3 step 5) has search tests that only pass with them.
- `onAttemptRollback` (needs human review): a third storage-client hook that D6 does not name. It runs when any attempt rolls back and only undoes in-process state (the successor-walk hold, the executing-step mark). Without it, runs never finalized under `--tx-replay`. Details under "Decisions inside my authority". The Postgres client implements it.
- Check 11 mechanism (needs human review): dependency-cruiser cannot reject `Bun.SQL` (a named export of the built-in `bun` module, also a global). `check:dep-graph` now runs depcruise and then an AST scan (`check-driver-imports.ts`) that rejects `import { SQL } from "bun"` and `Bun.SQL` outside `packages/storage-postgres`. One allowed file, reason on the line: `src/be/sql-connections.ts` (user-configured script databases, present at the base commit).
- E2E Postgres runner pre-applies the migration chain (part 6): the reader role needs the tables before the SUT starts. The SUT's own migration run is then a no-op; a fresh-database boot is covered by the contract tests and the manual boot proof (M3 results).
- Keyed task creation (`POST /api/tasks` with an idempotency key) stays SERIALIZABLE above the 5% target: keyed creation stays SERIALIZABLE; 90% retry rate comes from a scenario that races one key on purpose; approved by Daniel 2026-11-21.
- Four more sites stay SERIALIZABLE above the 5% target (approved by Daniel 2026-11-21): schedule run-now, KV increment and keyed workflow creation (single-row races on purpose in the scenario), and agent registration (25 at once, 59.3%, once per worker start). Exhausted retries 0, 5xx 0. See the D7 section.
- JSON key order, approved by Daniel 2026-11-21 (exception to section 10 for these assertions only): for jsonb columns, the byte-order JSON comparison became a parsed strict deep-equal. Scenarios: `divergence-values` (`users.metadata`), `platform-users-lifecycle` (`user_identity_events.afterJson`, avatar change) and `platform-users-access` (`beforeJson`/`afterJson`, role change). No value or key assertion was removed.
- Local Postgres is a private cluster from Ubuntu packages, not Docker (no Docker in the container). pgvector 0.6.0 locally, 0.8.x in CI.

## Open risks

- Integrations that start after `/health` answers: `linear-emulate-flows` flaked once on Postgres (part 10) because `initLinear` runs after the server listens. Webhook secrets are fixed (part 10); Linear and Jira OAuth rows are not.

- Postgres full text differs from FTS5 in known ways: no non-ASCII case folding under the C ctype, no accent removal, porter vs snowball stems, text past 100,000 characters (tasks) or tsvector position 16,383 not searchable by phrase. D15 tests pass on the fixed corpus.
- Memory full text on Postgres costs about 0.1 ms per matching row (each match rebuilds its tsvector): a term that matches 20,000 memories took 2.2 to 2.7 s. A stored tsvector column would fix it; the bench (M5) decides.
- `listCalibrationSessions` on Postgres reads a JSON string token (`"5"`) as NULL where SQLite returns the text; the caller turns it into 0 instead of 5.

- Unit-test failures blamed on the base commit are partly the container environment: the host shell sets `BOOT_SCRUB_MODE=forward-only` (all 7 boot retro-sweep failures) and `RBAC_ENABLED=false` (5 RBAC HTTP failures). With both unset those tests pass on the base and on the branch. Run check 16 with `env -u BOOT_SCRUB_MODE -u RBAC_ENABLED`.
- Parallel domain moves share one git stash list across worktrees; two agents popped each other's stash once (restored, verified byte-equal). Rule: no `git stash` in this work.

- Check 1 at the base commit and at M1 head: the strict gate needs an `in_progress` task row at the end of the run. Crash recovery reroutes the claimed tasks of earlier scenarios, so none survive. Fix in M2: add a parity scenario whose worker keeps a heartbeat and a claimed task until the run ends, or document a reasoned exclusion (an exclusion needs Taras-level care under section 10).
- `slack-lead-follow-up-card` flaked once in four full runs on this host (load average up to 39 during the runs). Watch it in CI.

- Size: 1,480 call sites and 2,454 statement strings. One session per milestone is not enough for M2 to M4.
- jsonb string binding (spike finding above).

## New allowlist, exclusion or quarantine entries

`// tx-replay-safe:` comments (check 15), each with its reason on the same line:

- `src/tools/store-progress.ts`: a fresh per-attempt object replaces the previous attempt's.
- `src/workflows/foreach-driver.ts` (6 lines): the per-process claim set must change under the write lock; the callback first gives back the previous attempt's claims.
- `src/workflows/successor-routing.ts` (1 line): a rolled-back attempt releases its own hold through `onAttemptRollback`.
- `scripts/check-async-db-seam.sh` ALLOWLIST (part 5): `src/be/storage-root.ts`, reason on the line: the composition root owns the engine-handle identity and the prompt-template seed inside `initDb` (SQLite start path).

`check:schema-parity` allowlist (M4 memory search, migration 369):

- `table:memory_vec`: Postgres form of the run-time sqlite-vec table (pgvector, no fixed dimension); SQLite creates its `memory_vec` at run time outside the chain.
- `index:idx_agent_memory_fts`: Postgres form of the run-time FTS5 table `memory_fts` (expression GIN index on `agent_memory`); SQLite creates `memory_fts` at run time outside the chain.

## Edited scenarios

See "M1 results / Edited scenarios".

- `divergence-values`, `platform-users-lifecycle`, `platform-users-access` (part 7): jsonb JSON compared by parsed deep-equal, not text (approved deviation, see "Deviations").
- `platform-chat-sdk-rocketchat`, `platform-webhooks`, `slack-thread-one-card` (part 9): SQL portability (see M7 results).
- `divergence-db-query-denial` (part 6): the parameterized query binds with `$1` instead of `?` (both dialects accept `$1`; SQL portability, no assertion change).

## New scenarios after M1

- `data-copy` (part 9, order 9010): check 20.

- `stress-task-create` (part 10, order 9442, flow `storage-engine-parity`): concurrent unkeyed creates; measures the D7 site of unkeyed task creation.
- `divergence-tracker-dedup` (part 10, order 9441, flow `storage-engine-parity`): one task per Linear tracker key under a race; guards the SERIALIZABLE split of task creation.
- `stress-task-finish` (part 8, order 9444, flow `storage-engine-parity`): concurrent finishes; guards the D7 locks of task finish.
- `task-live-claim` (part 4, order 9990, runs last): a worker claims a task and keeps a heartbeating session on it, so the strict gate's `task-statuses` surface sees `in_progress`. Closes the base-commit coverage gap without an exclusion.

## Edited unit tests (D5 import or SQL-text only)

- Part 6: `db-task-read-contract` and `db-task-write-contract` facade manifests list the 4 exports the Postgres start added to `db.ts`; `routing-affinity-inventory` counts the insert-row `routingAffinity` field (2, was 1); `seed-scripts` and `heartbeat-jev-gate` pinned SQL text follows the ported scripts; memory tests `await getHealth()`.

- `src/tests/skill-usage-cohorts.test.ts`: the query-plan exemption matches `MIN("createdAt")` (identifier now quoted per D8).
- `src/tests/claude-managed-adapter.test.ts` (part 5, timing only): the fake event stream waits 20 ms before each event. With the resolver async through storage, the in-process note render takes a few async reads; back-to-back fake events settled the session first. No assertion changed.

## 2026-11-22: re-review blocker, starter dashboard after db-copy (part 13)
- Problem: db-copy runs the chain on the empty target, then writes the SQLite rows, so the starter dashboard reverted to SQLite SQL. The API on the copy skips 370 (recorded), and the dashboard fails on COLLATE NOCASE.
- Fix 2e259f671: db-copy reruns the migrations listed in `src/be/migrations/postgres/after-copy.json` (370) inside the copy transaction, after the checksum comparison.
- Proof: `data-copy` scenario now runs the starter on the copy. Postgres: FAIL at c1342144 (400 collation "nocase"), PASS at 2e259f671. storage-postgres package tests 452/452.
- Fork main already equal to upstream cacd91a6. Merged origin/main into the branch: a1515e2f0.
