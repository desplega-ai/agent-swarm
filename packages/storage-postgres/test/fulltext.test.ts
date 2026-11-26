import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type DbClient, type SqlQuery, type Storage, sql } from "@desplega/storage";
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
/** The text and parameters of the last task page statement. */
let lastPage: { text: string; params: unknown[] } | null = null;

/** The client, recording each task page statement it runs. */
function recording(client: DbClient): DbClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "query" || typeof value !== "function") return value;
      return (text: string, params: unknown[] = []) => {
        if (text.trimStart().startsWith("WITH page")) lastPage = { text, params };
        return value.call(target, text, params);
      };
    },
  });
}

beforeAll(async () => {
  scratch = await createScratchDatabase("fulltext");
  db = createPostgresClient(scratch.url, { max: 2 });
  await runPostgresMigrations(db, { migrationsDir: CHAIN_DIR, log: () => {}, warn: () => {} });
  storage = createPostgresStorage(recording(db), { vectorSearch: false, queryReader: null });
}, 60_000); // applies the full baseline: a budget, not a retry

afterAll(async () => {
  await db.close();
  await scratch.drop();
});

/** The plan of the last task page statement, with sequential scans priced out. */
async function lastPagePlan(): Promise<string> {
  const page = lastPage;
  if (!page) throw new Error("no task page statement ran");
  return storage.transaction(async () => {
    await db.run("SET LOCAL enable_seqscan = off");
    const rows = await db.query<{ "QUERY PLAN": string }>(
      `EXPLAIN ${page.text}`,
      page.params as never,
    );
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
}

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

  test("a task search reads the stored documents, and parses no task text once the backfill is complete", async () => {
    await storage.repos.tasks.listTasks({ search: "deploy the" }, { limit: 20, offset: 0 }, "slim");
    const plan = await lastPagePlan();
    expect(plan).toContain("agent_tasks_search_task_doc");
    expect(plan).toContain("agent_tasks_search_title_doc");
    expect(plan).not.toContain("to_tsvector");
    expect(plan).not.toContain("agent_tasks_fts_task");
  });

  test("until the backfill mark is complete, the tasks past it match through the expressions of 368", async () => {
    await storage.executor.run(
      sql`UPDATE agent_tasks_fts_state SET "indexedThrough" = 0 WHERE id = 1`,
    );
    try {
      await storage.repos.tasks.listTasks({ search: "deploy" }, { limit: 20, offset: 0 }, "slim");
      const plan = await lastPagePlan();
      // The planner reads that arm by the expression indexes or by the _rowid
      // range, by its cost; on 77,000 long tasks it reads the indexes.
      expect(plan).toContain("agent_tasks_search_task_doc");
      expect(plan).toContain("_rowid > 0");
      expect(plan).toContain("to_tsvector");
    } finally {
      await storage.executor.run(
        sql`UPDATE agent_tasks_fts_state SET "indexedThrough" = 9007199254740991 WHERE id = 1`,
      );
    }
  });

  test("a written task stores one search document, cut to the first 100000 characters, deleted with the task", async () => {
    const text = `heron ${"x ".repeat(60_000)}tailword`;
    await storage.repos.tasks.insertSimpleTask({
      id: "doc",
      key: "shared/task:doc/",
      agentId: "a1",
      task: text,
      status: "pending",
      source: "api",
      slackChannelId: null,
      slackThreadTs: null,
      slackUserId: null,
      swarmVersion: "1.0.0",
      isHumanFree: false,
    });
    const search = (term: string) => storage.repos.tasks.countTasks({ search: term });
    expect(await search("heron")).toBe(1);
    // Past the first 100000 characters: not searchable, as with the expression of 368.
    expect(await search("tailword")).toBe(0);
    const doc = await storage.executor.get<{ same: string }>(sql`
      SELECT CASE WHEN task_doc = to_tsvector('simple', fts_words(${text})) THEN 'equal' ELSE 'different' END AS same
      FROM agent_tasks_search WHERE task_id = 'doc'`);
    expect(doc?.same).toBe("equal");
    expect(await storage.repos.tasks.deleteTask("doc")).toBe(1);
    const left = await storage.executor.get<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM agent_tasks_search WHERE task_id = 'doc'`,
    );
    expect(left?.n).toBe(0);
  });
});
