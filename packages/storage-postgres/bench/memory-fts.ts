#!/usr/bin/env bun
/**
 * Memory full-text search benchmark on Postgres, with a parity check against
 * SQLite FTS5 on the same corpus (decision D15).
 *
 *   BENCH_POSTGRES_URL=postgres://user:pass@127.0.0.1:5432/postgres \
 *     bun packages/storage-postgres/bench/memory-fts.ts [--rows 50000] [--runs 5] [--parity]
 *
 * The URL names a maintenance database on a server with pgvector (for example
 * `docker run -e POSTGRES_PASSWORD=bench -p 5432:5432 pgvector/pgvector:pg16`).
 * The run creates one scratch database and drops it at the end.
 *
 * Steps: apply the chain up to `--existing-head` (default 385, the head before
 * the stored documents), load the synthetic corpus as rows that already exist,
 * apply the rest of the chain (timed: on a branch with migration 386 this is
 * the backfill of the existing rows), then time each query through
 * `searchFtsRows` with the store's search reader. The script runs on any
 * checkout of this repository, so the same file measures main and a branch.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemorySearchFilter, Storage } from "@desplega/storage";
import { createBunSqliteClient, createSqliteStorage } from "../../storage-sqlite/src";
import { createPostgresClient, createPostgresStorage, runPostgresMigrations } from "../src";
import { buildCorpus, type Corpus, type CorpusRow, documentFrequencies } from "./corpus";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PG_CHAIN = join(ROOT, "src", "be", "migrations", "postgres");
const SQLITE_CHAIN = join(ROOT, "src", "be", "migrations");

function option(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
}

const ROWS = option("rows", 50_000);
const RUNS = option("runs", 5);
const EXISTING_HEAD = option("existing-head", 385);
const PARITY = process.argv.includes("--parity");
const ADMIN_URL = process.env.BENCH_POSTGRES_URL ?? process.env.STORAGE_TEST_POSTGRES_URL;
if (!ADMIN_URL) throw new Error("set BENCH_POSTGRES_URL to a maintenance database URL");

const quiet = { log: () => {}, warn: () => {} };
const FILTER: MemorySearchFilter = {
  agentId: "agent-3",
  scope: "all",
  isLead: false,
  includeExpired: false,
};

/** The benchmark queries: rare, common, eight common terms, and a phrase. */
function queries(corpus: Corpus): { label: string; terms: string[] }[] {
  const df = documentFrequencies(corpus.rows);
  const share = (word: string) => df.get(word) ?? 0;
  const v = corpus.vocabulary;
  const pick = (low: number, high: number, from = 0) =>
    v.slice(from).find((word) => share(word) >= low && share(word) <= high) as string;
  const eight: string[] = [];
  for (const [low, high] of [
    [0.55, 0.6],
    [0.45, 0.5],
    [0.38, 0.42],
    [0.3, 0.34],
    [0.24, 0.27],
    [0.18, 0.2],
    [0.13, 0.15],
    [0.1, 0.11],
  ] as const) {
    eight.push(pick(low, high));
  }
  return [
    { label: "rare term", terms: [pick(0.003, 0.004, 1000)] },
    { label: "common term", terms: [pick(0.3, 0.34)] },
    { label: "8 common terms", terms: eight },
    { label: "phrase term", terms: [corpus.phrase.join("-")] },
  ];
}

function describe(corpus: Corpus, terms: string[]): string {
  const df = documentFrequencies(corpus.rows);
  return terms
    .map((term) =>
      term.includes("-") ? `"${term}"` : `${term} ${((df.get(term) ?? 0) * 100).toFixed(1)}%`,
    )
    .join(", ");
}

async function insertRows(
  execute: (text: string, params: unknown[]) => Promise<unknown>,
  rows: CorpusRow[],
) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const params: unknown[] = [];
    const tuples = batch.map((row, j) => {
      params.push(row.id, row.agentId, row.scope, row.name, row.content);
      const b = j * 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, 'manual', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`;
    });
    await execute(
      `INSERT INTO agent_memory (id, "agentId", scope, name, content, source, "createdAt", "accessedAt", "updatedAt") VALUES ${tuples.join(", ")}`,
      params,
    );
  }
}

/** The chain files up to `head`, as a directory the migration runner reads. */
function partialChain(head: number): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-fts-bench-chain-"));
  for (const file of readdirSync(PG_CHAIN)) {
    const version = Number.parseInt(file, 10);
    if (/^\d+_.+\.sql$/.test(file) && version <= head)
      symlinkSync(join(PG_CHAIN, file), join(dir, file));
  }
  return dir;
}

async function timeQueries(storage: Storage, list: { label: string; terms: string[] }[]) {
  const reader = storage.memoryIndexes.searchReader;
  const results: { label: string; median: number; min: number; rows: number }[] = [];
  for (const { label, terms } of list) {
    const times: number[] = [];
    let rows = 0;
    // One warm-up run, then RUNS timed runs.
    for (let run = 0; run <= RUNS; run++) {
      const started = performance.now();
      const hits = await storage.repos.memory.searchFtsRows(terms, FILTER, 50, reader);
      const elapsed = performance.now() - started;
      if (run > 0) times.push(elapsed);
      rows = hits.length;
    }
    times.sort((a, b) => a - b);
    results.push({
      label,
      median: times[Math.floor(times.length / 2)] as number,
      min: times[0] as number,
      rows,
    });
  }
  return results;
}

function sqliteStorage(corpus: Corpus): { storage: Storage; db: Database } {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  const files = readdirSync(SQLITE_CHAIN)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const file of files) db.exec(readFileSync(join(SQLITE_CHAIN, file), "utf8"));
  db.run(`CREATE VIRTUAL TABLE memory_fts USING fts5(
    memory_id UNINDEXED, name, content, tokenize='porter unicode61')`);
  const insert = db.prepare(
    `INSERT INTO agent_memory (id, agentId, scope, name, content, source, createdAt, accessedAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'manual', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  );
  db.transaction(() => {
    for (const row of corpus.rows)
      insert.run(row.id, row.agentId, row.scope, row.name, row.content);
  })();
  db.run(
    "INSERT INTO memory_fts (memory_id, name, content) SELECT id, name, content FROM agent_memory",
  );
  return {
    storage: createSqliteStorage(
      createBunSqliteClient(() => db),
      { vectorSearch: false },
    ),
    db,
  };
}

async function parity(pg: Storage, corpus: Corpus, list: { label: string; terms: string[] }[]) {
  const { storage: lite, db } = sqliteStorage(corpus);
  const extra = [
    {
      label: "two rare terms",
      terms: [corpus.vocabulary[4000] as string, corpus.vocabulary[9000] as string],
    },
    {
      label: "mixed rare and common",
      terms: [
        corpus.vocabulary[40] as string,
        corpus.vocabulary[2500] as string,
        corpus.vocabulary[120] as string,
      ],
    },
    {
      label: "phrase and word",
      terms: [corpus.phrase.join("-"), corpus.vocabulary[700] as string],
    },
  ];
  const rows: string[] = [];
  let failed = 0;
  for (const { label, terms } of [...list, ...extra]) {
    const all = ROWS * 2;
    const [a, b] = await Promise.all([
      lite.repos.memory.searchFtsRows(terms, FILTER, all),
      pg.repos.memory.searchFtsRows(terms, FILTER, all, pg.memoryIndexes.searchReader),
    ]);
    const liteIds = new Set(a.map((r) => r.id));
    const pgIds = new Set(b.map((r) => r.id));
    const sameSet = liteIds.size === pgIds.size && [...liteIds].every((id) => pgIds.has(id));
    const liteTop = a.slice(0, 5).map((r) => r.id);
    const pgTop = new Set(b.slice(0, 5).map((r) => r.id));
    const shared = liteTop.filter((id) => pgTop.has(id)).length;
    const liteTop50 = a.slice(0, 50).map((r) => r.id);
    const pgTop50 = new Set(b.slice(0, 50).map((r) => r.id));
    const shared50 = liteTop50.filter((id) => pgTop50.has(id)).length;
    const ok = sameSet && shared >= Math.min(4, liteTop.length);
    if (!ok) failed++;
    rows.push(
      `| ${label} | ${liteIds.size} | ${pgIds.size} | ${sameSet ? "yes" : "NO"} | ${shared}/5 | ${shared50}/50 | ${ok ? "pass" : "FAIL"} |`,
    );
  }
  db.close();
  console.log("\nParity with SQLite FTS5 (D15: same id set, at least 4 of the first 5 ids):\n");
  console.log(
    "| Query | SQLite ids | Postgres ids | Same set | Top 5 shared | Top 50 shared | D15 |",
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const row of rows) console.log(row);
  return failed;
}

const corpus = buildCorpus(ROWS);
const name = `bench_memory_fts_${Date.now()}`;
const admin = new Bun.SQL(ADMIN_URL);
await admin.unsafe(
  `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
);
await admin.close();
const url = new URL(ADMIN_URL);
url.pathname = `/${name}`;
const client = createPostgresClient(url.toString(), { max: 4 });
let failed = 0;
try {
  const chain = partialChain(EXISTING_HEAD);
  try {
    await runPostgresMigrations(client, { migrationsDir: chain, ...quiet });
  } finally {
    rmSync(chain, { recursive: true, force: true });
  }
  const loadStarted = performance.now();
  await insertRows((text, params) => client.run(text, params as never), corpus.rows);
  const loadMs = performance.now() - loadStarted;
  const migrateStarted = performance.now();
  const applied = await runPostgresMigrations(client, { migrationsDir: PG_CHAIN, ...quiet });
  const migrateMs = performance.now() - migrateStarted;
  await client.run("VACUUM ANALYZE");
  const storage = createPostgresStorage(client, { vectorSearch: false, queryReader: null });

  const lengths = corpus.rows.map((row) => row.content.length).sort((a, b) => a - b);
  const average = lengths.reduce((sum, n) => sum + n, 0) / lengths.length;
  console.log(
    `corpus: ${ROWS} memories, content ${Math.round(average)} characters on average, p95 ${lengths[Math.floor(lengths.length * 0.95)]}, max ${lengths[lengths.length - 1]}`,
  );
  console.log(`load of the existing rows: ${(loadMs / 1000).toFixed(1)} s`);
  console.log(
    `migrations after ${EXISTING_HEAD} on the existing rows: ${(migrateMs / 1000).toFixed(1)} s (${JSON.stringify(applied)})`,
  );
  const list = queries(corpus);
  const results = await timeQueries(storage, list);
  console.log(`\nsearchFtsRows, limit 50, ${RUNS} warm runs after one warm-up:\n`);
  console.log("| Query | Terms (share of memories) | Rows | Median ms | Min ms |");
  console.log("|---|---|---|---|---|");
  for (const [i, r] of results.entries()) {
    const terms = list[i]?.terms ?? [];
    console.log(
      `| ${r.label} | ${describe(corpus, terms)} | ${r.rows} | ${Math.round(r.median)} | ${Math.round(r.min)} |`,
    );
  }
  if (PARITY) failed = await parity(storage, corpus, list);
} finally {
  await client.close();
  const dropper = new Bun.SQL(ADMIN_URL);
  await dropper.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await dropper.close();
}
process.exit(failed > 0 ? 1 : 0);
