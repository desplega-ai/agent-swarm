import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type QueryReader,
  QueryReaderDeniedError,
  QueryReaderNotQueryError,
  QueryReaderTimeoutError,
} from "@desplega/storage";
import { z } from "zod";
import { getStorage } from "../be/storage";
import { createSweepScrubber, scrubObject } from "../utils/secret-scrubber";
import {
  acquireBoundedQuerySlot,
  executeReadOnlyQueryBounded,
  releaseBoundedQuerySlot,
  timeoutError,
} from "./db-query-bounded";
import {
  assertSingleStatement,
  DbQueryConcurrencyCapError,
  DbQueryDeniedTableError,
  type DbQueryResult,
  DbQueryTimeoutError,
  executeReadOnlyQuery,
  getDbQueryHttpBudgetMs,
  getDbQueryHttpMaxRows,
  isDbQueryBoundedEnabled,
  stripTrailingSemicolon,
  warnDbQueryBoundedDisabledOnce,
} from "./db-query-shared";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

export type { DbQueryResult } from "./db-query-shared";
export {
  assertNoDeniedTables,
  assertSingleStatement,
  DB_QUERY_DENIED_TABLES,
  DbQueryDeniedTableError,
  executeReadOnlyQuery,
  getDbQueryHttpBudgetMs,
  getDbQueryHttpMaxRows,
  getDbQueryMcpBudgetMs,
  isDbQueryBoundedEnabled,
} from "./db-query-shared";

export const DbQueryInputShape = {
  sql: z.string().min(1).max(10_000).optional(),
  query: z.string().min(1).max(10_000).optional().describe("Deprecated runtime alias for sql."),
  params: z.array(z.any()).optional().default([]),
};

export const DbQueryInputSchema = z
  .object(DbQueryInputShape)
  .refine((body) => body.sql !== undefined || body.query !== undefined, {
    message: "Either sql or query is required",
  });

export type DbQueryInput = z.infer<typeof DbQueryInputSchema>;

export interface DbQueryResponse extends DbQueryResult {
  truncated: boolean;
  rowLimit: number | null;
  /** SQL dialect of the engine that ran the query (Postgres brief D10). */
  dialect: "sqlite" | "postgres";
}

export function resolveDbQuerySql(input: Pick<DbQueryInput, "sql" | "query">): string {
  return input.sql ?? input.query ?? "";
}

export function assertSelectOnlyQuery(sql: string): void {
  assertSingleStatement(sql);
  const normalized = stripTrailingSemicolon(sql).toLowerCase();
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new Error("Metric queries must start with SELECT or WITH");
  }
}

/** The engine has no db-query connection (Postgres without decision D10's restricted role). */
export class DbQueryUnavailableError extends Error {
  constructor() {
    super(
      "db-query is not available on this storage engine (Postgres): set DATABASE_QUERY_URL to a restricted read-only role that passes the start probe (see runbooks/postgres.md)",
    );
    this.name = "DbQueryUnavailableError";
  }
}

function assertDbQueryAvailable(): void {
  if (!getStorage().capabilities.dbQuery) throw new DbQueryUnavailableError();
}

/**
 * Gate in front of the bounded executor (Fix 1). `DB_QUERY_BOUNDED_ENABLED`
 * (default on) picks the path: enabled runs the bounded child-process
 * executor unchanged; disabled restores the pre-fix synchronous path with no
 * wall-clock budget and logs a one-time warning, so turning off the
 * protection can't happen silently.
 */
export async function executeReadOnlyQueryGated(
  sql: string,
  params: unknown[] = [],
  budgetMs: number,
  maxRows?: number,
): Promise<DbQueryResponse> {
  assertDbQueryAvailable();
  const reader = getStorage().queryReader;
  let result: DbQueryResult;
  if (reader) {
    result = await runOnQueryReader(reader, sql, params, budgetMs, maxRows);
  } else if (isDbQueryBoundedEnabled()) {
    result = await executeReadOnlyQueryBounded(sql, params, budgetMs, maxRows);
  } else {
    warnDbQueryBoundedDisabledOnce();
    result = executeReadOnlyQuery(sql, params, maxRows);
  }

  return {
    ...result,
    truncated: maxRows !== undefined && result.total > maxRows,
    rowLimit: maxRows ?? null,
    dialect: getStorage().capabilities.dbQueryDialect,
  };
}

/**
 * Run user SQL on the engine's own `db-query` reader (Postgres, decision D10):
 * the native dialect, a READ ONLY transaction with a statement timeout, under a
 * role that cannot read the denied tables. Shares the concurrency cap of the
 * bounded SQLite path.
 */
async function runOnQueryReader(
  reader: QueryReader,
  sql: string,
  params: unknown[],
  budgetMs: number,
  maxRows?: number,
): Promise<DbQueryResult> {
  assertSingleStatement(sql);
  acquireBoundedQuerySlot();
  try {
    return await reader.run(stripTrailingSemicolon(sql), params, { budgetMs, maxRows });
  } catch (err) {
    if (err instanceof QueryReaderDeniedError) throw new DbQueryDeniedTableError(err.tables);
    if (err instanceof QueryReaderTimeoutError) throw timeoutError(budgetMs);
    if (err instanceof QueryReaderNotQueryError) throw new Error(err.message);
    throw err;
  } finally {
    releaseBoundedQuerySlot();
  }
}

/**
 * The metrics path: the synchronous SQLite reader as before, or the engine's
 * `db-query` reader (with the HTTP budget) when the engine has one.
 */
export async function executeReadOnlyQueryNative(
  sql: string,
  params: unknown[] = [],
  maxRows?: number,
): Promise<DbQueryResult> {
  assertDbQueryAvailable();
  const reader = getStorage().queryReader;
  if (reader) return runOnQueryReader(reader, sql, params, getDbQueryHttpBudgetMs(), maxRows);
  return executeReadOnlyQuery(sql, params, maxRows);
}

const dbQueryRoute = route({
  method: "post",
  path: "/api/db-query",
  pattern: ["api", "db-query"],
  summary: "Execute a read-only SQL query",
  tags: ["Debug"],
  body: DbQueryInputSchema,
  responses: {
    200: {
      description: "Query results",
      schema: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.any())),
        elapsed: z.number(),
        total: z.number(),
        truncated: z.boolean(),
        rowLimit: z.number().nullable(),
        dialect: z
          .enum(["sqlite", "postgres"])
          .describe("SQL dialect of the storage engine that ran the query"),
      }),
    },
    400: {
      description: "Invalid or disallowed SQL, including queries that read credential tables",
    },
    408: { description: "Query exceeded its wall-clock budget and was terminated" },
    429: { description: "Too many concurrent bounded db-query executions; retry shortly" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated: "read-only SQL for agents, same posture as the db-query tool; user roles need admin",
  },
});

export async function handleDbQuery(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!dbQueryRoute.match(req.method, pathSegments)) {
    return false;
  }

  const parsed = await dbQueryRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  try {
    const result = await executeReadOnlyQueryGated(
      resolveDbQuerySql(parsed.body),
      parsed.body.params,
      getDbQueryHttpBudgetMs(),
      getDbQueryHttpMaxRows(),
    );
    // Rows can hold secrets pasted into free text (task output, logs, events).
    // The MCP tool gets this from the registrar; the HTTP route does it here.
    // The scrub is synchronous, so one sweep scrubber per request stays valid; it
    // skips the rules a clean row cannot trigger (rows run to MBs on this route).
    dbQueryRoute.respond(
      res,
      200,
      scrubObject(result, undefined, undefined, createSweepScrubber()),
    );
  } catch (err: unknown) {
    if (err instanceof DbQueryConcurrencyCapError) {
      // Machine-readable code + Retry-After so a caller can back off instead
      // of treating this like a malformed request (the pre-existing generic
      // 400 every other error path here returns).
      res.setHeader("Retry-After", "1");
      json(res, { error: "db_query_concurrency_cap", message: err.message }, 429);
      return true;
    }
    if (err instanceof DbQueryTimeoutError) {
      json(res, { error: "db_query_timeout", message: err.message }, 408);
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    jsonError(res, message);
  }

  return true;
}
