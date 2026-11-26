import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@desplega/storage";
import { createBunSqliteClient, createSqliteStorage } from "../src";

type TaskRow = {
  id: string;
  task: string;
  title: string | null;
  status: string;
  taskType: string | null;
  tags: string;
  priority: number;
  createdAt: string;
  lastUpdatedAt: string;
};

/**
 * A SQLite storage in `file` at the chain head with `rows` as tasks, indexed
 * by the FTS5 triggers of migration 257: the SQLite side of the result check
 * in packages/storage-postgres/bench/task-search.ts.
 */
export function openSqliteTaskCorpus(
  file: string,
  rows: Iterable<TaskRow>,
): { storage: Storage; close(): void } {
  const chain = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations");
  const db = new Database(file);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  const files = readdirSync(chain)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const name of files) db.exec(readFileSync(join(chain, name), "utf8"));
  const insert = db.prepare(
    `INSERT INTO agent_tasks (id, task, title, status, taskType, tags, priority, createdAt, lastUpdatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const flush = db.transaction((batch: TaskRow[]) => {
    for (const r of batch) {
      insert.run(
        r.id,
        r.task,
        r.title,
        r.status,
        r.taskType,
        r.tags,
        r.priority,
        r.createdAt,
        r.lastUpdatedAt,
      );
    }
  });
  let batch: TaskRow[] = [];
  for (const row of rows) {
    batch.push(row);
    if (batch.length >= 1000) {
      flush(batch);
      batch = [];
    }
  }
  flush(batch);
  return {
    storage: createSqliteStorage(
      createBunSqliteClient(() => db),
      { vectorSearch: false },
    ),
    close: () => db.close(),
  };
}
