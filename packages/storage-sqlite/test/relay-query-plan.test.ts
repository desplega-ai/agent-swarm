import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@desplega/storage";
import { createBunSqliteClient, createSqliteStorage } from "../src";

// The relay polls run every few seconds. Without `sqlite_stat1` (production
// never runs ANALYZE) a plain JOIN let the planner start from agent_tasks and
// visit every finished task per tick (#3580). The plan must start from the
// pending obligations and read each task by primary key.

const MIGRATIONS_DIR = join(import.meta.dir, "../../../src/be/migrations");

let db: Database;
let storage: Storage;
let statements: string[];

beforeEach(() => {
  db = new Database(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const file of files) db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  const insert = db.prepare(
    `INSERT INTO agent_tasks (id, task, status, source, createdAt, lastUpdatedAt, finishedAt, "contextKey")
     VALUES (?, 't', ?, 'api', ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 300; i++) {
    const at = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    const status = ["completed", "failed", "cancelled"][i % 3];
    insert.run(`t${i}`, status, at, at, at, `task:chat-sdk:discord:c${i}`);
  }
  statements = [];
  storage = createSqliteStorage(
    createBunSqliteClient(() => db, undefined, { onStatement: (sql) => statements.push(sql) }),
    { vectorSearch: false },
  );
});

afterEach(() => db.close());

function planOf(table: string, params: (string | number)[]): string {
  const sql = statements.find((statement) => statement.includes(table));
  if (!sql) throw new Error(`no statement read ${table}`);
  return db
    .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join("\n");
}

test("chat relay poll plans from the pending obligations", async () => {
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get()).toBeNull();
  const now = "2026-11-23T00:00:00.000Z";
  await storage.repos.messaging.listPendingChatRelayTasks(now, 200, ["slack", "discord"]);
  const plan = planOf("chat_relay_obligations", [
    "task:chat-sdk:slack:*",
    "task:chat-sdk:discord:*",
    now,
    200,
  ]);
  expect(plan.split("\n")[0]).toBe("SCAN obligation USING INDEX idx_chat_relay_obligations_pending");
  expect(plan).toContain("SEARCH task USING INDEX sqlite_autoindex_agent_tasks_1 (id=?)");
  expect(plan).not.toContain("idx_agent_tasks_status_finishedAt");
});

test("Slack relay poll plans from the pending obligations", async () => {
  await storage.repos.messaging.listPendingSlackRelayTasks();
  const plan = planOf("slack_relay_obligations", []);
  expect(plan.split("\n")[0]).toBe(
    "SCAN obligation USING INDEX idx_slack_relay_obligations_pending",
  );
  expect(plan).toContain("SEARCH task USING INDEX sqlite_autoindex_agent_tasks_1 (id=?)");
  expect(plan).not.toContain("idx_agent_tasks_status_finishedAt");
});
