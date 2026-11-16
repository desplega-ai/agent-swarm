/**
 * Worker thread entry for memory search reads. It holds its own read-only
 * connection to the API's WAL database file (with sqlite-vec when the host
 * has it), so the vec KNN and bm25 statements block this thread, not the API
 * event loop. Host side: search-reader.ts.
 */

import { Database } from "bun:sqlite";
import type { DbParam } from "../db-client";

declare const self: Worker;

export type SearchReadInit = {
  type: "init";
  file: string;
  vecExtensionPath?: string;
  customSQLite?: string;
};
export type SearchReadRequest = {
  type: "read";
  id: number;
  mode: "all" | "get";
  sql: string;
  params: DbParam[];
};
export type SearchReadMessage =
  | { type: "ready"; sqliteVec: boolean }
  | { type: "fatal"; message: string }
  | { type: "result"; id: number; rows: unknown }
  | { type: "error"; id: number; message: string; name: string; code?: string };

let db: Database | null = null;

self.onmessage = (event: MessageEvent<SearchReadInit | SearchReadRequest | { type: "close" }>) => {
  const message = event.data;
  if (message.type === "close") {
    db?.close();
    process.exit(0);
  }
  if (message.type === "init") {
    try {
      if (message.customSQLite) Database.setCustomSQLite(message.customSQLite);
      db = new Database(message.file, { readonly: true });
      // Same lock wait as the main connection; WAL readers rarely wait at all.
      db.run("PRAGMA busy_timeout = 5000;");
      db.run("PRAGMA mmap_size = 268435456;");
      let sqliteVec = false;
      if (message.vecExtensionPath) {
        db.loadExtension(message.vecExtensionPath);
        sqliteVec = Boolean(db.query("SELECT vec_version() AS version").get());
      }
      self.postMessage({ type: "ready", sqliteVec } satisfies SearchReadMessage);
    } catch (err) {
      self.postMessage({
        type: "fatal",
        message: (err as Error).message,
      } satisfies SearchReadMessage);
    }
    return;
  }
  const { id, mode, sql, params } = message;
  try {
    // db.query caches the statement, as the main connection's client does.
    const statement = db!.query<unknown, DbParam[]>(sql);
    const rows = mode === "all" ? statement.all(...params) : statement.get(...params);
    self.postMessage({ type: "result", id, rows } satisfies SearchReadMessage);
  } catch (err) {
    self.postMessage({
      type: "error",
      id,
      message: (err as Error).message,
      name: (err as Error).name,
      code: (err as Error & { code?: string }).code,
    } satisfies SearchReadMessage);
  }
};
