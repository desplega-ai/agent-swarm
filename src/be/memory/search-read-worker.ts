/**
 * Worker thread entry for memory search reads. It holds its own read-only
 * connection to the API's WAL database file (with sqlite-vec when the host
 * has it), so the vec KNN and bm25 statements block this thread, not the API
 * event loop. Host side: search-reader.ts.
 */

import { Database } from "bun:sqlite";
import type { DbParam } from "../db-client";

declare const self: Worker;

export type SearchReadInit = { type: "init"; file: string; vecExtensionPath?: string };
export type SearchReadRequest = {
  type: "read";
  id: number;
  mode: "all" | "get";
  sql: string;
  params: DbParam[];
};
export type SearchReadMessage =
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "result"; id: number; rows: unknown }
  | { type: "error"; id: number; message: string };

let db: Database | null = null;

self.onmessage = (event: MessageEvent<SearchReadInit | SearchReadRequest>) => {
  const message = event.data;
  if (message.type === "init") {
    try {
      db = new Database(message.file, { readonly: true });
      // Same lock wait as the main connection; WAL readers rarely wait at all.
      db.run("PRAGMA busy_timeout = 5000;");
      db.run("PRAGMA mmap_size = 268435456;");
      if (message.vecExtensionPath) db.loadExtension(message.vecExtensionPath);
      self.postMessage({ type: "ready" } satisfies SearchReadMessage);
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
    } satisfies SearchReadMessage);
  }
};
