#!/usr/bin/env bun
/**
 * Task search benchmark on Postgres (`GET /api/tasks?search=`: the page and
 * its total), with an optional result check against SQLite FTS5.
 *
 *   BENCH_POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/postgres \
 *     bun packages/storage-postgres/bench/task-search.ts \
 *       [--rows 77000] [--runs 5] [--existing-head 385] [--out result.json] \
 *       [--warmup 1] [--only <label part>] [--batch 50] [--no-backfill] [--stop-backfill-at <rows>] [--rebuild] [--explain] [--sqlite /tmp/tasks.sqlite]
 *       [--compare a.json b.json]
 *
 * The URL names a maintenance database (for example of
 * `docker run -e POSTGRES_PASSWORD=bench -p 5432:5432 pgvector/pgvector:pg18`).
 *
 * Steps:
 * 1. A template database with the chain up to `--existing-head` and the
 *    synthetic corpus (bench/task-search-corpus.ts) as rows that already
 *    exist. It is built once and kept (`bench_tasks_<rows>_h<head>`), as the
 *    load takes minutes; drop it by hand.
 * 2. A copy of the template, then the rest of the chain of this checkout
 *    (timed), then the task search backfill of the API (timed), then ANALYZE.
 *    `--no-backfill` skips the backfill, and `--stop-backfill-at <rows>` stops
 *    it after that many rows, to measure search while it runs.
 *    `--rebuild` then times the build of every stored search document in one
 *    statement, as db-copy runs it.
 * 3. Each query through the tasks repository, as the API runs it: one warm-up
 *    and `--runs` timed runs of the page (limit 20) and of the count.
 *
 * The script runs on any checkout of this repository, so the same file
 * measures main and a branch. `--out` writes the ids and counts of each
 * query; `--compare` reports whether two such files hold the same results.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbClient, Storage, TaskListFilters } from "@desplega/storage";
import { openSqliteTaskCorpus } from "../../storage-sqlite/bench/task-search-corpus";
import { createPostgresClient, createPostgresStorage, runPostgresMigrations } from "../src";
import { type TaskCorpusRow, taskCorpusRows, taskCorpusWords } from "./task-search-corpus";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PG_CHAIN = join(ROOT, "src", "be", "migrations", "postgres");

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

type QueryResult = { label: string; search: string; ids: string[]; count: number };
type RunResult = {
  migrateMs: number;
  backfillMs: number;
  queries: (QueryResult & { pageMs: number[]; countMs: number[] })[];
};

if (process.argv.includes("--compare")) {
  const at = process.argv.indexOf("--compare");
  const [a, b] = [process.argv[at + 1], process.argv[at + 2]].map(
    (file) => JSON.parse(readFileSync(file as string, "utf8")) as RunResult,
  );
  let same = true;
  for (const query of a!.queries) {
    const other = b!.queries.find((q) => q.label === query.label);
    const equal =
      other !== undefined &&
      other.count === query.count &&
      JSON.stringify(other.ids) === JSON.stringify(query.ids);
    same &&= equal;
    console.log(`${equal ? "same" : "DIFFERENT"}  ${query.label} (count ${query.count})`);
  }
  process.exit(same ? 0 : 1);
}

const ROWS = Number(option("rows") ?? 77_000);
const RUNS = Number(option("runs") ?? 5);
const WARMUP = Number(option("warmup") ?? 1);
const EXISTING_HEAD = Number(option("existing-head") ?? 385);
const BATCH = Number(option("batch") ?? 50);
const OUT = option("out");
const SQLITE_FILE = option("sqlite");
const EXPLAIN = process.argv.includes("--explain");
const REBUILD = process.argv.includes("--rebuild");
const NO_BACKFILL = process.argv.includes("--no-backfill");
const STOP_AT = Number(option("stop-backfill-at") ?? 0);
const ADMIN_URL = process.env.BENCH_POSTGRES_URL ?? process.env.STORAGE_TEST_POSTGRES_URL;
if (!ADMIN_URL) throw new Error("set BENCH_POSTGRES_URL to a maintenance database URL");

const quiet = { log: () => {}, warn: () => {} };
const TEMPLATE = `bench_tasks_${ROWS}_h${EXISTING_HEAD}`;
const SCRATCH = "bench_tasks_run";

function urlOf(database: string): string {
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin<T>(run: (sql: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new Bun.SQL(ADMIN_URL as string);
  try {
    return await run(sql);
  } finally {
    await sql.close();
  }
}

/** A directory of symlinks to the Postgres chain files up to `head`. */
function chainUpTo(head: number): { dir: string; drop(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pgts-chain-"));
  for (const file of readdirSync(PG_CHAIN)) {
    const ordinal = Number.parseInt(file, 10);
    if (/^\d+_/.test(file) && ordinal > head) continue;
    symlinkSync(join(PG_CHAIN, file), join(dir, file));
  }
  return { dir, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

const COLUMNS = `id, task, title, status, "taskType", tags, priority, "createdAt", "lastUpdatedAt"`;

function values(row: TaskCorpusRow): (string | number | null)[] {
  return [
    row.id,
    row.task,
    row.title,
    row.status,
    row.taskType,
    row.tags,
    row.priority,
    row.createdAt,
    row.lastUpdatedAt,
  ];
}

async function buildTemplate(): Promise<void> {
  const exists = await admin(
    (sql) =>
      sql.unsafe("SELECT 1 FROM pg_database WHERE datname = $1", [TEMPLATE]) as Promise<unknown[]>,
  );
  if (exists.length > 0) return;
  const building = `${TEMPLATE}_building`;
  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
    await sql.unsafe(
      `CREATE DATABASE ${building} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
  });
  const chain = chainUpTo(EXISTING_HEAD);
  const db = createPostgresClient(urlOf(building), { max: 2 });
  try {
    await runPostgresMigrations(db, { migrationsDir: chain.dir, log: () => {}, warn: () => {} });
    const loadStart = performance.now();
    const conn = new Bun.SQL(urlOf(building));
    // The load writes the rows first and builds the text indexes once at the end.
    await conn.unsafe(`DROP INDEX IF EXISTS agent_tasks_fts_task`);
    await conn.unsafe(`DROP INDEX IF EXISTS agent_tasks_fts_title`);
    let batch: TaskCorpusRow[] = [];
    let chars = 0;
    let rows = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const params: (string | number | null)[] = [];
      const tuples = batch.map((row) => {
        const base = params.length;
        params.push(...values(row));
        return `(${Array.from({ length: 9 }, (_, i) => `$${base + i + 1}`).join(", ")})`;
      });
      await conn.unsafe(`INSERT INTO agent_tasks (${COLUMNS}) VALUES ${tuples.join(", ")}`, params);
      batch = [];
    };
    for (const row of taskCorpusRows(ROWS)) {
      batch.push(row);
      chars += row.task.length;
      rows += 1;
      if (batch.length >= 200) await flush();
      if (rows % 10_000 === 0) console.log(`[bench] loaded ${rows} rows`);
    }
    await flush();
    console.log(
      `[bench] loaded ${rows} rows, ${(chars / 1e6).toFixed(0)} M chars of task text in ${Math.round(performance.now() - loadStart)} ms`,
    );
    const indexStart = performance.now();
    await conn.unsafe(`SET maintenance_work_mem = '1GB'`);
    await conn.unsafe(
      `CREATE INDEX "agent_tasks_fts_task" ON "agent_tasks" USING gin ((to_tsvector('simple', fts_words("task"))))`,
    );
    await conn.unsafe(
      `CREATE INDEX "agent_tasks_fts_title" ON "agent_tasks" USING gin ((to_tsvector('simple', fts_words("title"))))`,
    );
    console.log(
      `[bench] built the migration 368 indexes in ${Math.round(performance.now() - indexStart)} ms`,
    );
    await conn.unsafe("VACUUM ANALYZE agent_tasks");
    await conn.close();
  } finally {
    await db.close();
    chain.drop();
  }
  await admin((sql) => sql.unsafe(`ALTER DATABASE ${building} RENAME TO ${TEMPLATE}`));
}

/** A client that prints the plan of each task page and count statement first. */
function explaining(client: DbClient): DbClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop !== "query" && prop !== "get") || typeof value !== "function") return value;
      return async (text: string, params?: unknown[]) => {
        if (/^\s*(WITH page|SELECT COUNT\(\*\) as count FROM agent_tasks)/.test(text)) {
          const plan = await target.query<{ "QUERY PLAN": string }>(
            `EXPLAIN (ANALYZE, BUFFERS) ${text}`,
            params as never,
          );
          console.log(plan.map((row) => row["QUERY PLAN"]).join("\n"));
        }
        return value.call(target, text, params);
      };
    },
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

function benchQueries(idPrefix: string): { label: string; search: string }[] {
  const words = taskCorpusWords();
  return [
    { label: "word with no match", search: "zqxvnomatch" },
    { label: "rare word", search: words.rareWord },
    { label: "common word", search: "review" },
    { label: "phrase of 3 common words (occurs)", search: words.phrase },
    { label: "phrase of 4 common words (no match)", search: "fix the memory search" },
    { label: "id prefix", search: idPrefix },
  ];
}

const FILTERS = (search: string): TaskListFilters => ({ search });
const PAGE = { limit: 20, offset: 0 };

async function runQueries(
  storage: Storage,
  queries: { label: string; search: string }[],
  runs: number,
  warmup = WARMUP,
): Promise<RunResult["queries"]> {
  const results: RunResult["queries"] = [];
  for (const { label, search } of queries) {
    const tasks = storage.repos.tasks;
    const pageMs: number[] = [];
    const countMs: number[] = [];
    let ids: string[] = [];
    let count = 0;
    for (let run = 0; run < warmup + runs; run++) {
      const page = await timed(() => tasks.listTasks(FILTERS(search), PAGE, "slim"));
      const total = await timed(() => tasks.countTasks(FILTERS(search)));
      ids = page.value.map((row) => row.id);
      count = total.value;
      if (run < warmup) continue;
      pageMs.push(page.ms);
      countMs.push(total.ms);
    }
    results.push({ label, search, ids, count, pageMs, countMs });
    console.log(
      `[bench] ${label}: ${count} matches, page ${pageMs.map((ms) => ms.toFixed(0)).join("/")} ms, count ${countMs.map((ms) => ms.toFixed(0)).join("/")} ms`,
    );
  }
  return results;
}

function printTable(title: string, queries: RunResult["queries"]): void {
  console.log(`\n${title}`);
  console.log("| query | matches | page ms (median) | count ms (median) |");
  console.log("|---|---:|---:|---:|");
  for (const q of queries) {
    console.log(
      `| ${q.label} | ${q.count} | ${median(q.pageMs).toFixed(1)} | ${median(q.countMs).toFixed(1)} |`,
    );
  }
}

/** The same corpus in SQLite at the chain head, searched through FTS5. */
async function sqliteResults(
  file: string,
  queries: { label: string; search: string }[],
): Promise<RunResult["queries"]> {
  rmSync(file, { force: true });
  const lite = openSqliteTaskCorpus(file, taskCorpusRows(ROWS));
  const results = await runQueries(lite.storage, queries, 1, 0);
  lite.close();
  return results;
}

await buildTemplate();
await admin(async (sql) => {
  await sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await sql.unsafe(`CREATE DATABASE ${SCRATCH} TEMPLATE ${TEMPLATE}`);
});
const client = createPostgresClient(urlOf(SCRATCH), { max: 4 });
const storage = createPostgresStorage(EXPLAIN ? explaining(client) : client, {
  vectorSearch: false,
  queryReader: null,
});
try {
  const migrate = await timed(() =>
    runPostgresMigrations(client, { migrationsDir: PG_CHAIN, ...quiet }),
  );
  console.log(
    `[bench] applied ${migrate.value.applied.length} migrations past ${EXISTING_HEAD} in ${Math.round(migrate.ms)} ms`,
  );
  const backfill = await timed(async () => {
    let batches = 0;
    while (!NO_BACKFILL) {
      const batch = await storage.transaction(() => storage.repos.tasks.indexTaskFtsBatch(BATCH));
      batches += 1;
      if (batch.done) break;
      if (STOP_AT && batches * BATCH >= STOP_AT) break;
    }
    return batches;
  });
  console.log(
    `[bench] task search backfill: ${backfill.value} batches of ${BATCH} in ${Math.round(backfill.ms)} ms`,
  );
  const documents = await client.get<{ table: string | null }>(
    `SELECT to_regclass('agent_tasks_search')::text AS table`,
  );
  if (documents?.table && REBUILD) {
    // The build in one statement, as db-copy runs it (and as a migration would).
    await client.run("TRUNCATE agent_tasks_search");
    const rebuild = await timed(() =>
      client.run(`INSERT INTO agent_tasks_search (task_id, task_doc, title_doc)
        SELECT id, task_search_document(task), task_search_document(title) FROM agent_tasks`),
    );
    console.log(
      `[bench] built every task search document in one statement in ${Math.round(rebuild.ms)} ms`,
    );
  }
  await client.run("ANALYZE");
  if (documents?.table) {
    const size = await client.get<{ heap: string; total: string; indexes: string }>(
      `SELECT pg_size_pretty(pg_relation_size('agent_tasks_search')) AS heap,
              pg_size_pretty(pg_total_relation_size('agent_tasks_search')) AS total,
              pg_size_pretty(pg_indexes_size('agent_tasks_search')) AS indexes`,
    );
    console.log(
      `[bench] agent_tasks_search: ${size?.total} in total (heap ${size?.heap}, indexes ${size?.indexes}, the rest TOAST)`,
    );
  }
  const sample = await client.get<{ id: string }>(
    `SELECT id FROM agent_tasks WHERE "_rowid" = 1234`,
  );
  const only = option("only");
  const queries = benchQueries((sample?.id ?? "").slice(0, 8)).filter(
    (query) => !only || query.label.includes(only),
  );
  const results = await runQueries(storage, queries, EXPLAIN ? 1 : RUNS, EXPLAIN ? 0 : WARMUP);
  if (!EXPLAIN) printTable(`Postgres, ${ROWS} tasks, ${RUNS} warm runs`, results);
  if (OUT) {
    const run: RunResult = { migrateMs: migrate.ms, backfillMs: backfill.ms, queries: results };
    writeFileSync(OUT, JSON.stringify(run, null, 2));
  }
  if (SQLITE_FILE) {
    const lite = await sqliteResults(SQLITE_FILE, queries);
    const longIds = new Set(
      (
        await client.query<{ id: string }>(`SELECT id FROM agent_tasks WHERE length(task) > 100000`)
      ).map((row) => row.id),
    );
    console.log("\nSQLite FTS5 against Postgres (same ids in the same order):");
    for (const query of results) {
      const other = lite.find((q) => q.label === query.label);
      const same = JSON.stringify(other?.ids) === JSON.stringify(query.ids);
      const note =
        other && other.count !== query.count
          ? ` (SQLite count ${other.count}; ${longIds.size} tasks are longer than 100,000 characters)`
          : "";
      console.log(
        `${same && other?.count === query.count ? "same" : "DIFFERENT"}  ${query.label}: page ${same ? "same" : "different"}, count ${query.count}${note}`,
      );
    }
    rmSync(SQLITE_FILE, { force: true });
    rmSync(`${SQLITE_FILE}-wal`, { force: true });
    rmSync(`${SQLITE_FILE}-shm`, { force: true });
  }
} finally {
  await client.close();
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
}
