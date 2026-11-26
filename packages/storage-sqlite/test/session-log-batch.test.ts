import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type NewSessionLog, SESSION_LOG_BATCH_ROWS, type Storage } from "@desplega/storage";
import { createBunSqliteClient, createSqliteStorage } from "../src";

// POST /api/session-logs wrote one INSERT per line (17 per request on average
// in production). insertLogs writes SESSION_LOG_BATCH_ROWS lines per statement.

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
  statements = [];
  storage = createSqliteStorage(
    createBunSqliteClient(() => db, undefined, { onStatement: (sql) => statements.push(sql) }),
    { vectorSearch: false },
  );
});

afterEach(() => db.close());

const line = (i: number): NewSessionLog => ({
  id: `l${i}`,
  taskId: null,
  sessionId: "s1",
  iteration: 1,
  cli: "claude",
  content: `line ${i}`,
  lineNumber: i,
  reasoningChars: null,
  reasoningKind: null,
});

const inserts = () => statements.filter((s) => /INSERT INTO session_logs/.test(s)).length;

test("insertLogs writes one statement per SESSION_LOG_BATCH_ROWS lines", async () => {
  await storage.repos.sessions.insertLogs([]);
  expect(inserts()).toBe(0);

  await storage.repos.sessions.insertLogs(Array.from({ length: 17 }, (_, i) => line(i)));
  expect(inserts()).toBe(1);

  statements = [];
  const many = Array.from({ length: SESSION_LOG_BATCH_ROWS * 2 + 1 }, (_, i) => line(100 + i));
  await storage.repos.sessions.insertLogs(many);
  expect(inserts()).toBe(3);
  expect(db.query("SELECT COUNT(*) AS n FROM session_logs").get()).toEqual({ n: 17 + many.length });
});
