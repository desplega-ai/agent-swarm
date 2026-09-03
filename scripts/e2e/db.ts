// The only file in scripts/e2e allowed to touch bun:sqlite. Seed data goes
// through the public API; this handle is for assertions only, so the
// connection is read-only and every write throws.
import { Database, type SQLQueryBindings } from "bun:sqlite";

export type ReadOnlyDb = {
  query: <T>(sql: string, params?: SQLQueryBindings[]) => T[];
  get: <T>(sql: string, params?: SQLQueryBindings[]) => T | null;
  close: () => void;
};

export function openReadOnlyDb(path: string): ReadOnlyDb {
  // Opened on first use: the file only exists once the SUT booted and ran its
  // migrations.
  let database: Database | undefined;
  const handle = (): Database => {
    database ??= new Database(path, { readonly: true });
    return database;
  };
  return {
    query: <T>(sql: string, params: SQLQueryBindings[] = []) =>
      handle()
        .query(sql)
        .all(...params) as T[],
    get: <T>(sql: string, params: SQLQueryBindings[] = []) =>
      (handle()
        .query(sql)
        .get(...params) as T | null) ?? null,
    close: () => {
      database?.close();
      database = undefined;
    },
  };
}
