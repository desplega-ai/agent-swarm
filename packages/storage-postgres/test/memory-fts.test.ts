import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MemorySearchFilter, type Storage, sql } from "@desplega/storage";
import {
  createPostgresClient,
  createPostgresStorage,
  type PostgresClient,
  runPostgresMigrations,
} from "../src";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

// Memory full text on Postgres reads stored documents (migration 386): the
// table memory_fts, written with each memory. The result parity with SQLite is
// in the contract suite; this file proves the parts only Postgres has.

const CHAIN_DIR = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations", "postgres");
const quiet = { log: () => {}, warn: () => {} };
const ALL: MemorySearchFilter = { agentId: "a1", scope: "all", isLead: true, includeExpired: true };

let scratch: ScratchDatabase;
let db: PostgresClient;
let storage: Storage;

/** The chain files before migration 386, as a directory the runner reads. */
function chainBefore386(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-fts-chain-"));
  for (const file of readdirSync(CHAIN_DIR)) {
    if (/^\d+_.+\.sql$/.test(file) && Number.parseInt(file, 10) < 386) {
      symlinkSync(join(CHAIN_DIR, file), join(dir, file));
    }
  }
  return dir;
}

async function insertMemory(id: string, name: string, content: string): Promise<void> {
  await storage.executor.run(sql`
    INSERT INTO agent_memory (id, "agentId", scope, name, content, source, "createdAt", "accessedAt")
    VALUES (${id}, 'a1', 'agent', ${name}, ${content}, 'manual', statement_timestamp(), statement_timestamp())`);
}

const ids = async (terms: string[]) =>
  (await storage.repos.memory.searchFtsRows(terms, ALL, 50)).map((row) => row.id).sort();

beforeAll(async () => {
  scratch = await createScratchDatabase("memoryfts");
  db = createPostgresClient(scratch.url, { max: 2 });
  storage = createPostgresStorage(db, { vectorSearch: false, queryReader: null });
  const before = chainBefore386();
  try {
    await runPostgresMigrations(db, { migrationsDir: before, ...quiet });
  } finally {
    rmSync(before, { recursive: true, force: true });
  }
  // Rows that exist before the migration, as on a database already in use.
  await insertMemory("old1", "heron notes", "A blue heron waded in.");
  await insertMemory("old2", "blue", "heron nests by the lake");
  await runPostgresMigrations(db, { migrationsDir: CHAIN_DIR, ...quiet });
}, 60_000); // applies the full baseline: a budget, not a retry

afterAll(async () => {
  await db.close();
  await scratch.drop();
});

describe("memory full text [postgres]", () => {
  test("migration 386 builds a document for each memory that existed before it", async () => {
    const rows = await storage.executor.query<{ memory_id: string; doc_len: number }>(
      sql`SELECT memory_id, doc_len FROM memory_fts ORDER BY memory_id`,
    );
    // "heron notes" + "A blue heron waded in." is 2 + 5 tokens.
    expect(rows).toEqual([
      { memory_id: "old1", doc_len: 7 },
      { memory_id: "old2", doc_len: 6 },
    ]);
    expect(await ids(["heron"])).toEqual(["old1", "old2"]);
    // A phrase stays inside one field: old2 has "blue" in the name, "heron" in the content.
    expect(await ids(["blue-heron"])).toEqual(["old1"]);
    expect(await storage.repos.memory.ftsTableSchema()).toContain("idx_memory_fts_doc");
  });

  test("the expression index of migration 369 is gone: a memory write runs no to_tsvector", async () => {
    const row = await storage.executor.get<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_agent_memory_fts'`,
    );
    expect(row?.n).toBe(0);
  });

  test("the FTS row writes follow the memory: insert, replace, delete, and the cascade", async () => {
    const repo = storage.repos.memory;
    await insertMemory("w1", "deploy runbook", "restart the worker pods");
    expect(await ids(["restart"])).toEqual([]);
    await repo.insertFtsRow("w1", "deploy runbook", "restart the worker pods");
    expect(await ids(["restart"])).toEqual(["w1"]);
    // insertFtsRow replaces the document of the old text.
    await repo.insertFtsRow("w1", "deploy runbook", "scale the worker pods");
    expect(await ids(["restart"])).toEqual([]);
    expect(await ids(["scale"])).toEqual(["w1"]);
    // insertMissingFtsRows skips a memory that has its document.
    await repo.insertMissingFtsRows(["w1"]);
    expect(await ids(["scale"])).toEqual(["w1"]);
    const scan = await repo.scanFtsBatch(0, 10);
    expect(scan.map((row) => [row.memoryId, row.orphan])).toEqual([
      ["old1", 0],
      ["old2", 0],
      ["w1", 0],
    ]);
    await repo.deleteMemoriesByIds(["w1"]);
    const left = await storage.executor.get<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM memory_fts WHERE memory_id = 'w1'`,
    );
    expect(left?.n).toBe(0);
  });

  test("a search reads the GIN index of memory_fts and never builds a document of stored text", async () => {
    const plan = await storage.transaction(async () => {
      await storage.executor.run(sql`SET LOCAL enable_seqscan = off`);
      const reader = {
        query: <T>(text: string, params: never[]) => db.query<T>(`EXPLAIN ${text}`, params),
        get: <T>(text: string, params: never[]) => db.get<T>(`EXPLAIN ${text}`, params),
      };
      const rows = (await storage.repos.memory.searchFtsRows(
        ["heron", "blue-heron"],
        ALL,
        10,
        reader,
      )) as unknown as { "QUERY PLAN": string }[];
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("idx_memory_fts_doc");
    // to_tsvector runs only on the query terms (bound values), never on a column.
    expect(plan).not.toMatch(/to_tsvector\([^)]*\b(name|content)\b/);
    expect(plan).not.toContain("memory_fts_document");
  });

  test("the search reader runs a READ ONLY transaction, and joins a caller's transaction", async () => {
    const reader = storage.memoryIndexes.searchReader;
    expect(reader).toBeDefined();
    const outside = await reader?.get<{ transaction_read_only: string }>(
      "SHOW transaction_read_only",
      [],
    );
    expect(outside?.transaction_read_only).toBe("on");
    await storage.transaction(async () => {
      await insertMemory("tx1", "pending", "uncommitted kingfisher");
      await storage.repos.memory.insertFtsRow("tx1", "pending", "uncommitted kingfisher");
      const hits = await storage.repos.memory.searchFtsRows(["kingfisher"], ALL, 10, reader);
      expect(hits.map((row) => row.id)).toEqual(["tx1"]);
    });
  });
});
