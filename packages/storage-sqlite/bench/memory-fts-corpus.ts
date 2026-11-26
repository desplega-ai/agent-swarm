import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@desplega/storage";
import { createBunSqliteClient, createSqliteStorage } from "../src";

/**
 * An in-memory SQLite storage at the chain head with the run-time FTS5 table
 * `memory_fts` filled from `rows`: the SQLite side of the full-text parity
 * check in packages/storage-postgres/bench/memory-fts.ts.
 */
export function openSqliteFtsCorpus(
  rows: { id: string; agentId: string; scope: string; name: string; content: string }[],
): { storage: Storage; close(): void } {
  const chain = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations");
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  const files = readdirSync(chain)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const file of files) db.exec(readFileSync(join(chain, file), "utf8"));
  // The table src/be/memory/providers/sqlite-store.ts creates at run time.
  db.run(`CREATE VIRTUAL TABLE memory_fts USING fts5(
    memory_id UNINDEXED, name, content, tokenize='porter unicode61')`);
  const insert = db.prepare(
    `INSERT INTO agent_memory (id, agentId, scope, name, content, source, createdAt, accessedAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'manual', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  );
  db.transaction(() => {
    for (const row of rows) insert.run(row.id, row.agentId, row.scope, row.name, row.content);
  })();
  db.run(
    "INSERT INTO memory_fts (memory_id, name, content) SELECT id, name, content FROM agent_memory",
  );
  return {
    storage: createSqliteStorage(
      createBunSqliteClient(() => db),
      { vectorSearch: false },
    ),
    close: () => db.close(),
  };
}
