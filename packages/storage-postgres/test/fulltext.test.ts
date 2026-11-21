import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type SqlQuery, type Storage, sql } from "@desplega/storage";
import {
  createPostgresClient,
  createPostgresStorage,
  type PostgresClient,
  runPostgresMigrations,
} from "../src";
import { SKILL_VECTOR } from "../src/repositories/skills";
import { TASK_TEXT_TSVECTOR, TASK_TITLE_TSVECTOR } from "../src/repositories/tasks";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

// Full-text search on Postgres (migration 368, decision D15): the repositories'
// tsvector expressions must equal the indexed ones, or every search reads the
// whole table. The result parity itself is in the contract suite.

const CHAIN_DIR = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations", "postgres");

let scratch: ScratchDatabase;
let db: PostgresClient;
let storage: Storage;

beforeAll(async () => {
  scratch = await createScratchDatabase("fulltext");
  db = createPostgresClient(scratch.url, { max: 2 });
  await runPostgresMigrations(db, { migrationsDir: CHAIN_DIR, log: () => {}, warn: () => {} });
  storage = createPostgresStorage(db, { vectorSearch: false, dbQuery: false });
}, 60_000); // applies the full baseline: a budget, not a retry

afterAll(async () => {
  await db.close();
  await scratch.drop();
});

/** The plan of `query` with sequential scans priced out. */
async function plan(query: SqlQuery): Promise<string> {
  return storage.transaction(async () => {
    await storage.executor.run(sql`SET LOCAL enable_seqscan = off`);
    const rows = await storage.executor.query<{ "QUERY PLAN": string }>(sql`EXPLAIN ${query}`);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
}

describe("full-text indexes [postgres]", () => {
  test("the skills search expression uses skills_fts_search", async () => {
    expect(
      await plan(
        sql`SELECT id FROM skills WHERE ${SKILL_VECTOR} @@ to_tsquery('english', 'deploy')`,
      ),
    ).toContain("skills_fts_search");
  });

  test("the task search expressions use agent_tasks_fts_task and agent_tasks_fts_title", async () => {
    const query = sql`to_tsquery('simple', 'deploy:*')`;
    expect(
      await plan(sql`SELECT id FROM agent_tasks WHERE ${TASK_TEXT_TSVECTOR} @@ ${query}`),
    ).toContain("agent_tasks_fts_task");
    expect(
      await plan(sql`SELECT id FROM agent_tasks WHERE ${TASK_TITLE_TSVECTOR} @@ ${query}`),
    ).toContain("agent_tasks_fts_title");
  });

  test("a text whose tsvector would pass 1 MB still inserts, and its start is searchable", async () => {
    // 40000 distinct hashes make a 1.4 MB tsvector; fts_words indexes the
    // first 100000 characters only, so the expression index cannot fail.
    const hashes = Array.from({ length: 40000 }, (_, i) =>
      new Bun.CryptoHasher("md5").update(String(i)).digest("hex"),
    );
    const text = `needle ${hashes.join(" ")}`;
    await storage.executor.run(sql`
      INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt")
      VALUES ('big', ${text}, 'pending', statement_timestamp(), statement_timestamp())`);
    const hit = await storage.executor.get<{ id: string }>(
      sql`SELECT id FROM agent_tasks WHERE ${TASK_TEXT_TSVECTOR} @@ to_tsquery('simple', 'needle')`,
    );
    expect(hit?.id).toBe("big");
  });
});
