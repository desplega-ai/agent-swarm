import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { executeReadOnlyQueryBounded } from "./db-query-bounded";
import {
  assertSingleStatement,
  DbQueryConcurrencyCapError,
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
  assertSingleStatement,
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
  let result: DbQueryResult;
  if (isDbQueryBoundedEnabled()) {
    result = await executeReadOnlyQueryBounded(sql, params, budgetMs, maxRows);
  } else {
    warnDbQueryBoundedDisabledOnce();
    result = executeReadOnlyQuery(sql, params, maxRows);
  }

  return {
    ...result,
    truncated: maxRows !== undefined && result.total > maxRows,
    rowLimit: maxRows ?? null,
  };
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
      }),
    },
    400: { description: "Invalid or disallowed SQL" },
    408: { description: "Query exceeded its wall-clock budget and was terminated" },
    429: { description: "Too many concurrent bounded db-query executions; retry shortly" },
  },
  auth: { apiKey: true },
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
    dbQueryRoute.respond(res, 200, result);
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
