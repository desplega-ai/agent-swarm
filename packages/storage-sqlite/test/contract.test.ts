import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@desplega/storage";
import * as sqliteVec from "sqlite-vec";
import { runStorageContract } from "../../storage/test/contract";
import { createBunSqliteClient, createSqliteStorage } from "../src";

// The migration chain is data: the SQL files are read, not imported. The
// TypeScript backfill next to them only touches existing rows, so an empty
// database needs none of it.
const MIGRATIONS_DIR = join(import.meta.dir, "../../../src/be/migrations");

let template: Uint8Array | null = null;

function headTemplate(): Uint8Array {
  if (template) return template;
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const file of files) db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  template = db.serialize();
  db.close();
  return template;
}

const open = new Map<Storage, Database>();

runStorageContract({
  name: "sqlite",
  async fresh() {
    const db = Database.deserialize(headTemplate());
    db.run("PRAGMA foreign_keys = ON");
    const storage = createSqliteStorage(
      createBunSqliteClient(() => db),
      { vectorSearch: false },
    );
    open.set(storage, db);
    return storage;
  },
  async release(storage) {
    open.get(storage)?.close();
    open.delete(storage);
  },
  async prepareMemorySearch(storage, dimensions) {
    // The tables src/be/memory/providers/sqlite-store.ts creates at run time.
    const db = open.get(storage);
    if (!db) throw new Error("prepareMemorySearch: unknown storage");
    sqliteVec.load(db);
    db.run(`CREATE VIRTUAL TABLE memory_fts USING fts5(
      memory_id UNINDEXED, name, content, tokenize='porter unicode61')`);
    db.run(`CREATE VIRTUAL TABLE memory_vec USING vec0(
      memory_id TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
  },
});
