import {
  type QueryReader,
  QueryReaderDeniedError,
  QueryReaderNotQueryError,
  type QueryReaderOptions,
  type QueryReaderResult,
  QueryReaderTimeoutError,
} from "@desplega/storage";
import { decodeValueRows, type ResultColumn, type TimestampFormats } from "./codec";

/**
 * The `db-query` connection of the Postgres engine (decision D10).
 *
 * It logs in from `DATABASE_QUERY_URL` as a restricted role. The security
 * boundary is that role: it has SELECT on the permitted tables only and no
 * write privilege. Each query also runs in a READ ONLY transaction with a
 * statement timeout, but those are limits, not the boundary. There is no
 * `SET ROLE` and no SQL text filter: user SQL can undo both.
 *
 * At start, {@link openPostgresQueryReader} probes the role. When a probe
 * fails, the reader is not opened and the engine has no `dbQuery` capability.
 */

const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_QUERY_CANCELED = "57014";
const SQLSTATE_SYNTAX_ERROR = "42601";
const SQLSTATE_FEATURE_NOT_SUPPORTED = "0A000";
const CURSOR = "swarm_db_query";
const DECLARE = `DECLARE ${CURSOR} NO SCROLL CURSOR FOR`;
/** Small: the bounded SQLite path also caps concurrent db-query runs (3 by default). */
const READER_POOL_MAX = 4;

// The Bun.SQL global, not `import { SQL } from "bun"`: the node-target CLI
// bundle includes this package and cannot import "bun" (see client.ts).
type SQL = InstanceType<typeof Bun.SQL>;

type PgError = { errno?: string; message?: string; position?: string };

function pgError(err: unknown): PgError {
  return typeof err === "object" && err !== null ? (err as PgError) : {};
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export type QueryReaderProbeResult =
  | { ok: true; reader: QueryReader; role: string }
  | { ok: false; reason: string };

/**
 * Open the reader and prove its role cannot read the denied tables and cannot
 * write. Every denied table must exist in the target schema (run the probe
 * after the migrations). Returns the reason when a probe fails; the caller logs
 * it (scrubbed) and leaves `dbQuery` off.
 */
export async function openPostgresQueryReader(
  url: string,
  deniedTables: readonly string[],
  timestampFormats: TimestampFormats | null = null,
): Promise<QueryReaderProbeResult> {
  let pool: SQL;
  try {
    pool = new Bun.SQL({ url, max: READER_POOL_MAX, idleTimeout: 30, connectionTimeout: 10 });
  } catch (err) {
    // A malformed optional URL (ERR_INVALID_URL) turns the reader off, not the API.
    return { ok: false, reason: `invalid reader URL: ${pgError(err).message ?? String(err)}` };
  }
  try {
    const reason = await probe(pool, deniedTables);
    if (reason) {
      await pool.close();
      return { ok: false, reason };
    }
    const [who] = (await pool.unsafe("SELECT current_user AS role")) as { role: string }[];
    return {
      ok: true,
      reader: new PostgresQueryReader(pool, timestampFormats),
      role: who?.role ?? "?",
    };
  } catch (err) {
    await pool.close().catch(() => undefined);
    return { ok: false, reason: `cannot connect: ${pgError(err).message ?? String(err)}` };
  }
}

/** The first rule the role breaks, or null when it holds. */
async function probe(pool: SQL, deniedTables: readonly string[]): Promise<string | null> {
  const [role] = (await pool.unsafe(
    `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb
       FROM pg_roles r WHERE r.rolname = current_user`,
  )) as {
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
  }[];
  if (!role) return "the login role is not in pg_roles";
  if (role.rolsuper) return `role ${role.rolname} is a superuser`;
  if (role.rolbypassrls) return `role ${role.rolname} has BYPASSRLS`;
  if (role.rolcreaterole) return `role ${role.rolname} has CREATEROLE`;
  if (role.rolcreatedb) return `role ${role.rolname} has CREATEDB`;

  const [db] = (await pool.unsafe(
    `SELECT has_database_privilege(current_database(), 'CREATE') AS can_create`,
  )) as { can_create: boolean }[];
  if (db?.can_create) return `role ${role.rolname} has CREATE on the database`;

  // Owners pass every grant check: the role must not own (or be a member of the
  // owner of) any relation, schema or function in a non-system schema.
  const owned = (await pool.unsafe(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
        AND pg_has_role(current_user, c.relowner, 'MEMBER')
     UNION ALL
     SELECT n.nspname FROM pg_namespace n
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
        AND (pg_has_role(current_user, n.nspowner, 'MEMBER') OR has_schema_privilege(n.oid, 'CREATE'))
     LIMIT 3`,
  )) as { name: string }[];
  if (owned.length > 0) {
    return `role ${role.rolname} owns or can create objects in: ${owned.map((r) => r.name).join(", ")}`;
  }

  const writable = (await pool.unsafe(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
        AND (
          (c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
              OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE')
              OR has_table_privilege(c.oid, 'TRIGGER') OR has_table_privilege(c.oid, 'REFERENCES')
              OR has_any_column_privilege(c.oid, 'INSERT') OR has_any_column_privilege(c.oid, 'UPDATE')))
          OR (c.relkind = 'S' AND has_sequence_privilege(c.oid, 'UPDATE'))
        )
      LIMIT 3`,
  )) as { name: string }[];
  if (writable.length > 0) {
    return `role ${role.rolname} can write to: ${writable.map((r) => r.name).join(", ")}`;
  }

  for (const table of deniedTables) {
    const [row] = (await pool.unsafe(
      `SELECT c.oid IS NOT NULL AS present,
              COALESCE(has_table_privilege(c.oid, 'SELECT') OR has_any_column_privilege(c.oid, 'SELECT'), false) AS readable
         FROM (SELECT to_regclass($1) AS oid) c`,
      [quoteIdent(table)],
    )) as { present: boolean; readable: boolean }[];
    if (!row?.present) return `denied table ${table} is not in the search path of the role`;
    if (row.readable) return `role ${role.rolname} can read the denied table ${table}`;
    // The catalog says no; prove it with the engine as well.
    const refusal = await refusedWith(pool, `SELECT 1 FROM ${quoteIdent(table)} LIMIT 0`);
    if (refusal !== SQLSTATE_INSUFFICIENT_PRIVILEGE) {
      return `reading the denied table ${table} did not fail with permission denied (got ${refusal ?? "success"})`;
    }
  }

  // A view runs with its owner's privileges: no view the role can read may
  // reach a denied table, directly or through other views.
  const leaking = (await pool.unsafe(
    `WITH RECURSIVE reach(view_oid, rel_oid) AS (
       SELECT r.ev_class, d.refobjid
         FROM pg_rewrite r JOIN pg_depend d ON d.objid = r.oid
        WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
          AND d.refobjid <> r.ev_class
       UNION
       SELECT reach.view_oid, d.refobjid
         FROM reach JOIN pg_rewrite r ON r.ev_class = reach.rel_oid
         JOIN pg_depend d ON d.objid = r.oid
        WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
          AND d.refobjid <> r.ev_class
     )
     SELECT DISTINCT reach.view_oid::regclass::text AS name
       FROM reach
      WHERE reach.rel_oid = ANY(SELECT to_regclass(t) FROM unnest($1::text[]) AS t)
        AND (has_table_privilege(reach.view_oid, 'SELECT')
          OR has_any_column_privilege(reach.view_oid, 'SELECT'))
      LIMIT 3`,
    [deniedTables.map(quoteIdent)],
  )) as { name: string }[];
  if (leaking.length > 0) {
    return `role ${role.rolname} can read views over a denied table: ${leaking.map((r) => r.name).join(", ")}`;
  }

  // A SECURITY DEFINER function runs with its owner's privileges and can write.
  const definers = (await pool.unsafe(
    `SELECT p.oid::regprocedure::text AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND has_function_privilege(p.oid, 'EXECUTE')
      LIMIT 3`,
  )) as { name: string }[];
  if (definers.length > 0) {
    return `role ${role.rolname} can run SECURITY DEFINER functions: ${definers.map((r) => r.name).join(", ")}`;
  }

  // A real write attempt, outside a READ ONLY transaction, so only the role refuses it.
  const writeRefusal = await refusedWith(pool, "INSERT INTO agents DEFAULT VALUES");
  if (writeRefusal !== SQLSTATE_INSUFFICIENT_PRIVILEGE) {
    return `a write to agents did not fail with permission denied (got ${writeRefusal ?? "success"})`;
  }
  return null;
}

/** Run `text` in a transaction that always rolls back; the SQLSTATE it failed with, or null. */
async function refusedWith(pool: SQL, text: string): Promise<string | null> {
  const ROLLBACK = Symbol("rollback");
  try {
    await pool.begin(async (tx) => {
      await tx.unsafe(text);
      throw ROLLBACK;
    });
    return null;
  } catch (err) {
    if (err === ROLLBACK) return null;
    return pgError(err).errno ?? "unknown error";
  }
}

/** The tables a "permission denied for table x" error names. */
function deniedTablesOf(message: string): string[] {
  const match = message.match(/permission denied for (?:table|view|relation|sequence) (\S+)/i);
  return match?.[1] ? [match[1].replace(/^"|"$/g, "")] : [];
}

class PostgresQueryReader implements QueryReader {
  constructor(
    private readonly pool: SQL,
    private readonly timestampFormats: TimestampFormats | null,
  ) {}

  async run(
    sql: string,
    params: unknown[],
    options: QueryReaderOptions,
  ): Promise<QueryReaderResult> {
    const start = performance.now();
    const deadline = start + options.budgetMs;
    const timeout = () => Math.max(1, Math.ceil(deadline - performance.now()));
    try {
      return await this.pool.begin("read only", async (tx) => {
        // Each statement gets what is left of the budget.
        await tx.unsafe(`SET LOCAL statement_timeout = ${timeout()}`);
        try {
          await tx.unsafe(`${DECLARE} ${sql}`, params);
        } catch (err) {
          // The cursor accepts only a query. A syntax error at the first token of
          // the user text, or a data-modifying WITH, means the text is not one.
          const { errno, position } = pgError(err);
          const leading = sql.length - sql.trimStart().length;
          const atFirstToken = Number(position) === DECLARE.length + 2 + leading;
          if (
            (errno === SQLSTATE_SYNTAX_ERROR && atFirstToken) ||
            errno === SQLSTATE_FEATURE_NOT_SUPPORTED
          ) {
            throw new QueryReaderNotQueryError();
          }
          throw err;
        }
        await tx.unsafe(`SET LOCAL statement_timeout = ${timeout()}`);
        const fetched = await tx
          .unsafe(
            options.maxRows === undefined
              ? `FETCH FORWARD ALL FROM ${CURSOR}`
              : `FETCH FORWARD ${Math.max(0, Math.floor(options.maxRows))} FROM ${CURSOR}`,
          )
          .values();
        const columns = ((fetched as unknown as { statement?: { columns?: ResultColumn[] } })
          .statement?.columns ?? []) as ResultColumn[];
        let total = fetched.length;
        if (options.maxRows !== undefined) {
          await tx.unsafe(`SET LOCAL statement_timeout = ${timeout()}`);
          const moved = await tx.unsafe(`MOVE FORWARD ALL FROM ${CURSOR}`);
          total += (moved as unknown as { count?: number }).count ?? 0;
        }
        // The read codec (D8): values in the SQLite shape, as the repositories return them.
        const rows = decodeValueRows(fetched as unknown[][], columns, this.timestampFormats);
        return {
          columns: columns.map((column) => column.name),
          rows,
          elapsed: Math.round(performance.now() - start),
          total,
        };
      });
    } catch (err) {
      const { errno, message } = pgError(err);
      if (errno === SQLSTATE_QUERY_CANCELED) throw new QueryReaderTimeoutError(options.budgetMs);
      if (errno === SQLSTATE_INSUFFICIENT_PRIVILEGE) {
        const tables = deniedTablesOf(message ?? "");
        if (tables.length > 0) throw new QueryReaderDeniedError(tables);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
