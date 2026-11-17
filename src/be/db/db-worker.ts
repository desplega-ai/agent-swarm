// The compiled API binary must list this file as an extra entrypoint (see Dockerfile).
import { Database } from "bun:sqlite";
import { createSyncSqliteDriver, type DbParam, type DriverOptions } from "../db-client";

declare const self: Worker;
export type DbWorkerRequest =
  | {
      type: "open";
      filename: string;
      vecExtensionPath?: string;
      vecExtensionRequired?: boolean;
      customSQLite?: string;
      pragmas: string[];
    }
  | {
      id: number;
      op: "all" | "get" | "run" | "runTimed" | "exec";
      sql: string;
      params: DbParam[];
      spinMs?: number;
      deadlineAt?: number;
    }
  | { type: "close" };
export type DbWorkerMessage =
  | { type: "ready"; sqliteVec: boolean }
  | { type: "fatal"; message: string }
  | { type: "closed" }
  | {
      id: number;
      value?: unknown;
      executionMs: number;
      error?: { message: string; code?: string; name: string };
    };
let db: Database | undefined;
let driver: ReturnType<typeof createSyncSqliteDriver> | undefined;
self.onmessage = ({ data }: MessageEvent<DbWorkerRequest>) => {
  try {
    if ("type" in data) {
      if (data.type === "open") {
        if (db) throw new Error("db-worker: database is already open");
        // Bun can return false after the main connection opened. The vector query
        // below verifies actual capability rather than treating this return as proof.
        if (data.customSQLite) Database.setCustomSQLite(data.customSQLite);
        db = new Database(data.filename, { create: false });
        for (const pragma of data.pragmas) db.exec(pragma);
        if (
          (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "wal"
        ) {
          throw new Error("db-worker: WAL mode is required");
        }
        let sqliteVec = false;
        if (data.vecExtensionPath) {
          try {
            db.loadExtension(data.vecExtensionPath);
            sqliteVec = Boolean(db.query("SELECT vec_version() AS version").get());
          } catch (error) {
            if (data.vecExtensionRequired !== false) throw error;
          }
        }
        driver = createSyncSqliteDriver(() => db!);
        self.postMessage({ type: "ready", sqliteVec } satisfies DbWorkerMessage);
      } else {
        db?.close();
        self.postMessage({ type: "closed" } satisfies DbWorkerMessage);
        process.exit(0);
      }
      return;
    }
    if (!driver) throw new Error("db-worker: database is not open");
    const options: DriverOptions = { spinMs: data.spinMs, deadlineAt: data.deadlineAt };
    const result =
      data.op === "exec"
        ? driver.exec(data.sql, options)
        : driver[data.op](data.sql, data.params, options);
    // The synchronous adapter returns before another message can execute.
    if (result instanceof Promise)
      throw new Error("db-worker: synchronous driver returned a promise");
    self.postMessage({ id: data.id, ...result } satisfies DbWorkerMessage);
  } catch (error) {
    const err = error as Error & { code?: string; executionMs?: number };
    if ("id" in data)
      self.postMessage({
        id: data.id,
        executionMs: err.executionMs ?? 0,
        error: { message: err.message, code: err.code, name: err.name },
      } satisfies DbWorkerMessage);
    else self.postMessage({ type: "fatal", message: err.message } satisfies DbWorkerMessage);
  }
};
