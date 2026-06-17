# SQL-seed fixtures (`scenario.seed.sqlDump`)

Fixtures referenced by `scenario.seed.sqlDump` live here as **INSERT-only SQL
seeds** — just the reference rows, no schema and no `_migrations`. They are
reviewable in git and tiny (a few KB).

The schema is **not** carried by the fixture. The runner builds it **pre-boot**
from the **real migrations** that ship in the API image: before the API server
first boots, `bootStack` (`src/swarm/sandbox.ts`) applies the migration `.sql`
files in `MIGRATIONS_DIR` (`/app/migrations`) to the fresh DB exactly the way
`src/be/migrations/runner.ts` does — same filename sort, same `_migrations`
bookkeeping (`version`, `name`, `applied_at`, `checksum`) — then applies the
INSERT-only seed on top. The API then boots; its migration runner finds
`_migrations` fully populated and applies **zero** further migrations, and its
boot-time caches see the seeded rows.

**Why INSERT-only?** The old convention shipped a full `sqlite3 .dump`
(schema + `_migrations` + rows, ~1 MB). That duplicated the entire schema in
every fixture and silently **drifted** whenever a migration changed a table. By
building the schema from the real migrations, the schema is always correct by
construction and the fixture is just the answer-key rows.

## Rules

- **INSERT-only.** No `CREATE TABLE`, no `_migrations`, no PRAGMAs/`BEGIN`/
  `COMMIT` — just `INSERT INTO …` rows (comments are fine). The runner rejects
  (fail-fast, pre-sandbox) any fixture that contains `CREATE TABLE` or
  references `_migrations` (that would be a stale full dump) or that carries no
  INSERT rows.
- **Seed reference data only** (historical tasks, scripts, workflows). Do NOT
  seed live operational state — the validator enforces these:
  - no `agents` rows — workers self-register at boot; a pre-seeded agent row
    with a colliding ID would be silently reused;
  - no in-flight tasks — `'pending'`/`'running'` rows would be claimed by the
    booting worker; seed only **terminal** rows
    (`completed`/`failed`/`cancelled`);
  - no sessions or locks.
- **No `agent_memory` rows** — embeddings live in a sqlite-vec virtual table and
  are not portable. Use `scenario.seed.memories` (indexed via the memory API,
  embedded server-side) instead.
- **Schema comes from the migrations**, so a seed is never "too old/new": the
  schema is always the image's migration set. Only constraint: the rows must
  match the columns the migrations actually create (a column removed by a future
  migration would make the INSERT fail at seed time — a loud, immediate failure).
- Keep fixtures small; the runner enforces a **5 MB** hard cap. Fixtures are
  reference data, not prod DBs.
- Filenames are bare (`name.sql`, no path separators) — enforced by
  `validateScenario` at registry load.

## Regenerating a fixture

Both fixtures are **generated, not hand-edited** — the answer-key rows live in
the generator's `TASKS` array. After any dataset change, re-run the generator
(it writes the `.sql` and prints the answer key), then mirror the printed answer
key into the scenario file. From `evals/`:

```bash
bun scenarios/fixtures/generate-delegation-probe-history.ts   # → delegation-probe-history.sql + answer key
bun scenarios/fixtures/generate-sql-audit-history.ts          # → sql-audit-history.sql + answer key
```

The generator validates its own output with `validateSqlDumpText` before
writing, so a rule violation fails the regen loudly.

## Fixtures

| File | Used by | Contents |
|---|---|---|
| `sql-audit-history.sql` | `sql-audit`, `distributed-audit` | INSERT-only seed of 30 terminal `agent_tasks` rows (completed/failed/cancelled) as an audit dataset with red herrings + one status/output-contradiction anomaly. **Generated, not hand-edited** — run `bun scenarios/fixtures/generate-sql-audit-history.ts`, then mirror the printed answer key into `scenarios/sql-audit.ts`. |
| `delegation-probe-history.sql` | `delegation-probe` | INSERT-only seed of 20 terminal `agent_tasks` rows (11 completed / 5 failed / 4 cancelled). Distinct titles + counts from `sql-audit-history.sql` (no anomaly — the delegation rubric grades delegate-then-merge, not anomaly hunting). The lead under test must DELEGATE the audit to two workers; the merged answer key (per-status counts + the highest-priority completed title "Provision the analytics warehouse cluster") lives only in these rows. **Generated, not hand-edited** — run `bun scenarios/fixtures/generate-delegation-probe-history.ts`, then mirror the printed answer key into `scenarios/delegation-probe.ts`. |
