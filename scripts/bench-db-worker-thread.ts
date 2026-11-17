// Compile this file as an additional entrypoint beside bench-db-worker.ts.
import type { Database } from "bun:sqlite";
import {
  checkVector,
  configureSQLite,
  errorDetails,
  execute,
  openDatabase,
  type Query,
  threadHeap,
} from "./bench-db-worker-fixture";

declare const self: Worker & { close(): void };
export type Request =
  | {
      type: "open";
      filename: string;
      customSQLite: string | null;
      extensionPath: string;
      exitFlag: SharedArrayBuffer;
    }
  | { type: "query"; query: Query }
  | { type: "heap"; collect: boolean }
  | { type: "close" };

let db: Database | undefined;
self.onmessage = ({ data }: MessageEvent<Request>) => {
  try {
    if (data.type === "open") {
      const exitFlag = new Int32Array(data.exitFlag);
      process.on("exit", () => Atomics.store(exitFlag, 0, 1));
      const customSQLite = configureSQLite(data.customSQLite);
      db = openDatabase(data.filename, false);
      const vector = checkVector(db, data.extensionPath);
      self.postMessage({
        customSQLite,
        vector,
        sqliteVersion: db.query("SELECT sqlite_version() AS version").get(),
        pragmas: db
          .query("SELECT * FROM pragma_journal_mode(), pragma_synchronous(), pragma_foreign_keys()")
          .get(),
      });
    } else if (data.type === "heap") {
      if (data.collect) Bun.gc(true);
      self.postMessage(threadHeap());
    } else if (data.type === "close") {
      db?.close();
      db = undefined;
      self.postMessage({ closed: true });
      process.exit(0);
    } else {
      if (!db) throw new Error("The benchmark database is not open.");
      self.postMessage(execute(db, data.query));
    }
  } catch (error) {
    self.postMessage({ error: errorDetails(error) });
  }
};
