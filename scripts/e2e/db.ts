// The only file in scripts/e2e allowed to open a database handle. Seed data goes
// through the public API; this handle is for assertions only, so the
// connection is read-only and every write throws.
//
// Scenarios write SQL with the `sql` tag, so one text runs on both engines: the tag
// renders `?` placeholders for SQLite and `$n` for Postgres. Identifiers with an
// uppercase letter are double-quoted in the scenario text (decision D8 of the
// Postgres brief), which both engines accept.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { resolve } from "node:path";

export type Engine = "sqlite" | "postgres";

const LIST = Symbol("sqlList");
const IDENT = Symbol("sqlIdent");
type SqlList = { [LIST]: readonly unknown[] };
type SqlIdent = { [IDENT]: string };
const ROWID = Symbol("insertionOrder");

/**
 * A table's insertion order in `sql` templates: SQLite's hidden `rowid`, or its
 * Postgres stand-in, the `_rowid` identity column (ledger: the `_rowid` surrogate).
 */
export const insertionOrder = { [ROWID]: true } as const;

/** A table or column name chosen by the scenario (never by input): rendered double-quoted. */
export function sqlIdent(name: string): SqlIdent {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Not a plain identifier: ${name}`);
  return { [IDENT]: name };
}

/** Expand an array into a placeholder list inside `sql`: `IN (${sqlList(ids)})`. */
export function sqlList(values: readonly unknown[]): SqlList {
  if (values.length === 0) throw new Error("sqlList needs at least one value");
  return { [LIST]: values };
}

export class SqlQuery {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  render(engine: Engine): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    const slot = (value: unknown) => {
      params.push(value);
      return engine === "postgres" ? `$${params.length}` : "?";
    };
    const walk = (query: SqlQuery): string => {
      let text = query.strings[0] ?? "";
      query.values.forEach((value, index) => {
        if (value instanceof SqlQuery) text += walk(value);
        else if (value && typeof value === "object" && LIST in value)
          text += (value as SqlList)[LIST].map(slot).join(", ");
        else if (value && typeof value === "object" && IDENT in value)
          text += `"${(value as SqlIdent)[IDENT]}"`;
        else if (value && typeof value === "object" && ROWID in value)
          text += engine === "postgres" ? `"_rowid"` : "rowid";
        else text += slot(value);
        text += query.strings[index + 1] ?? "";
      });
      return text;
    };
    return { text: walk(this), params };
  }
}

/**
 * Portable query text: `sql\`SELECT "taskId" FROM agent_tasks WHERE id = ${id}\``.
 * A value may be another `sql` fragment (inlined), `sqlList(values)` or `sqlIdent(name)`.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  return new SqlQuery([...strings], values);
}

export type ReadOnlyDb = {
  engine: Engine;
  query: <T>(query: SqlQuery | string) => T[];
  get: <T>(query: SqlQuery | string) => T | null;
  /**
   * The engine reclaims the space of deleted rows by itself: SQLite in
   * incremental auto-vacuum mode, Postgres with autovacuum on.
   */
  reclaimsFreeSpace: () => boolean;
  close: () => void;
};

const asQuery = (query: SqlQuery | string) =>
  typeof query === "string" ? new SqlQuery([query], []) : query;

export type DbTarget = { engine: "sqlite"; path: string } | { engine: "postgres"; url: string };

export function openReadOnlyDb(target: DbTarget | string): ReadOnlyDb {
  const resolved: DbTarget =
    typeof target === "string" ? { engine: "sqlite", path: target } : target;
  return resolved.engine === "postgres" ? openPostgres(resolved.url) : openSqlite(resolved.path);
}

function openSqlite(path: string): ReadOnlyDb {
  // Opened on first use: the file only exists once the SUT booted and ran its
  // migrations.
  let database: Database | undefined;
  const handle = (): Database => {
    database ??= new Database(path, { readonly: true });
    return database;
  };
  const prepare = (query: SqlQuery | string) => {
    const { text, params } = asQuery(query).render("sqlite");
    return { statement: handle().query(text), params: params as SQLQueryBindings[] };
  };
  return {
    engine: "sqlite",
    query: <T>(query: SqlQuery | string) => {
      const { statement, params } = prepare(query);
      return statement.all(...params) as T[];
    },
    get: <T>(query: SqlQuery | string) => {
      const { statement, params } = prepare(query);
      return (statement.get(...params) as T | null) ?? null;
    },
    reclaimsFreeSpace: () =>
      (handle().query("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | null)
        ?.auto_vacuum === 2,
    close: () => {
      database?.close();
      database = undefined;
    },
  };
}

// Postgres has no synchronous driver. Scenarios call ctx.db synchronously (often inside
// a poll predicate), so a worker owns the async Bun.SQL pool and the main thread blocks
// on Atomics.wait until the worker writes the JSON result into shared memory.
const RESULT_BYTES = 64 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 30_000;

function openPostgres(url: string): ReadOnlyDb {
  let worker: Worker | undefined;
  let control: Int32Array | undefined;
  let data: Uint8Array | undefined;
  const start = () => {
    if (worker) return;
    const controlBuffer = new SharedArrayBuffer(8);
    const dataBuffer = new SharedArrayBuffer(RESULT_BYTES);
    control = new Int32Array(controlBuffer);
    data = new Uint8Array(dataBuffer);
    worker = new Worker(resolve(import.meta.dir, "db-postgres-worker.ts"));
    worker.postMessage({ type: "init", url, controlBuffer, dataBuffer });
    worker.unref();
  };
  const call = (query: SqlQuery | string): unknown[] => {
    start();
    const { text, params } = asQuery(query).render("postgres");
    Atomics.store(control!, 0, 0);
    worker!.postMessage({ type: "query", text, params });
    const state = Atomics.wait(control!, 0, 0, QUERY_TIMEOUT_MS);
    if (state === "timed-out")
      throw new Error(`ctx.db query timed out after ${QUERY_TIMEOUT_MS} ms: ${text}`);
    const length = Atomics.load(control!, 1);
    const payload = JSON.parse(new TextDecoder().decode(data!.slice(0, length))) as
      | { ok: true; rows: unknown[] }
      | { ok: false; error: string };
    if (!payload.ok) throw new Error(`${payload.error}\n${text}`);
    return payload.rows;
  };
  return {
    engine: "postgres",
    query: <T>(query: SqlQuery | string) => call(query) as T[],
    get: <T>(query: SqlQuery | string) => (call(query)[0] as T | undefined) ?? null,
    reclaimsFreeSpace: () =>
      (call("SELECT current_setting('autovacuum') AS autovacuum")[0] as { autovacuum: string })
        ?.autovacuum === "on",
    close: () => {
      worker?.terminate();
      worker = undefined;
    },
  };
}

/**
 * `--engine postgres`: one new, empty database for each SUT boot on the server that
 * `E2E_POSTGRES_URL` names. The URL must log in as a role that may CREATE DATABASE.
 */
export async function createPostgresDatabase(stamp: string): Promise<string> {
  const admin = adminUrl();
  const name = `e2e_${stamp.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
  const client = new Bun.SQL({ url: admin, max: 1 });
  try {
    // Byte text order and ASCII-only case folding, like SQLite (ledger: C collation and ctype).
    await client.unsafe(
      `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
  } finally {
    await client.close();
  }
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The db-query reader role of a per-run database (decision D10). */
function readerRoleName(databaseUrl: string): string {
  return `${decodeURIComponent(new URL(databaseUrl).pathname.slice(1))}_reader`;
}

/**
 * Give a per-run database its db-query reader (decision D10), the way the
 * runbook tells an operator to: apply the migration chain first, then create a
 * LOGIN role with SELECT on every table except the denied ones. Returns the
 * `DATABASE_QUERY_URL`. The SUT then finds the chain applied and probes the role.
 */
export async function preparePostgresQueryReader(databaseUrl: string): Promise<string> {
  const { createPostgresClient, runPostgresMigrations } = await import(
    "../../packages/storage-postgres/src/index"
  );
  const { DB_QUERY_DENIED_TABLES } = await import("../../packages/storage/src/index");
  const setup = createPostgresClient(databaseUrl, { max: 1 });
  try {
    await runPostgresMigrations(setup, {
      migrationsDir: resolve(import.meta.dir, "../../src/be/migrations/postgres"),
    });
  } finally {
    await setup.close();
  }
  const role = readerRoleName(databaseUrl);
  const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  const sql = new Bun.SQL({ url: databaseUrl, max: 1 });
  try {
    // Bench only: `E2E_POSTGRES_SEED_SQL` names a SQL file that seeds the database
    // before the API boots (for example scripts/e2e/fixtures/postgres-bench-seed.sql).
    const seedFile = process.env.E2E_POSTGRES_SEED_SQL;
    if (seedFile) await sql.unsafe(await Bun.file(seedFile).text());
    await sql.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${role}'`);
    await sql.unsafe(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
    const denied = [...DB_QUERY_DENIED_TABLES].map((t) => `"${t}"`).join(", ");
    await sql.unsafe(`REVOKE SELECT ON ${denied} FROM "${role}"`);
  } finally {
    await sql.close();
  }
  const url = new URL(databaseUrl);
  url.username = role;
  // A password, not trust: CI's Postgres image requires scram over TCP.
  url.password = role;
  return url.toString();
}

export async function dropPostgresDatabase(databaseUrl: string): Promise<void> {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  const client = new Bun.SQL({ url: adminUrl(), max: 1 });
  try {
    await client.unsafe(`DROP DATABASE IF EXISTS "${name.replaceAll('"', '""')}" WITH (FORCE)`);
    await client.unsafe(
      `DROP ROLE IF EXISTS "${readerRoleName(databaseUrl).replaceAll('"', '""')}"`,
    );
  } finally {
    await client.close();
  }
}

function adminUrl(): string {
  const url = process.env.E2E_POSTGRES_URL;
  if (!url)
    throw new Error("--engine postgres needs E2E_POSTGRES_URL (a role that may CREATE DATABASE)");
  if (!/^postgres(ql)?:\/\//.test(url))
    throw new Error("E2E_POSTGRES_URL must start with postgres:// or postgresql://");
  return url;
}

export type DbFixture = { name: string; file: Uint8Array; meta: Record<string, unknown> };

/** A database fixture under scripts/e2e/fixtures: `<name>.sqlite.gz` + `<name>.json`. */
export async function loadDbFixture(name: string): Promise<DbFixture> {
  const dir = resolve(import.meta.dir, "fixtures");
  const gz = new Uint8Array(await Bun.file(`${dir}/${name}.sqlite.gz`).arrayBuffer());
  return {
    name,
    file: Bun.gunzipSync(gz),
    meta: (await Bun.file(`${dir}/${name}.json`).json()) as Record<string, unknown>,
  };
}

/** Put a fixture's SQLite file in place before the SUT boots on it. */
export async function restoreSqliteFixture(path: string, fixture: DbFixture): Promise<void> {
  await Bun.write(path, fixture.file);
}

/**
 * Turn one stored secret into a pre-encryption legacy row on a stopped SQLite SUT,
 * and drop every other encrypted row. The legacy-secret scenario boots on this state.
 */
export function makeSqliteSecretLegacy(path: string, key: string, plaintext: string): void {
  const db = new Database(path);
  try {
    db.run("DELETE FROM swarm_config WHERE encrypted = 1 AND key <> ?", [key]);
    db.run("UPDATE swarm_config SET value = ?, encrypted = 0 WHERE key = ?", [plaintext, key]);
  } finally {
    db.close();
  }
}

/**
 * A superuser LOGIN role with `password` on the E2E Postgres server, for a scenario
 * that checks how the API reads a password. Drop it with `dropPostgresRole`.
 */
export async function createPostgresRole(role: string, password: string): Promise<void> {
  const client = new Bun.SQL({ url: adminUrl(), max: 1 });
  try {
    await client.unsafe(
      `CREATE ROLE "${role.replaceAll('"', '""')}" LOGIN SUPERUSER PASSWORD '${password.replaceAll("'", "''")}'`,
    );
  } finally {
    await client.close();
  }
}

export async function dropPostgresRole(role: string): Promise<void> {
  const client = new Bun.SQL({ url: adminUrl(), max: 1 });
  try {
    await client.unsafe(`DROP ROLE IF EXISTS "${role.replaceAll('"', '""')}"`);
  } finally {
    await client.close();
  }
}
