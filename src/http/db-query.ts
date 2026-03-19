import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb } from "../be/db";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  elapsed: number;
  total: number;
}

/**
 * Execute a read-only SQL query against the swarm database.
 * Detects write statements via bun:sqlite's columnNames (empty for INSERT/UPDATE/DELETE/DROP).
 */
export function executeReadOnlyQuery(
  sql: string,
  params: unknown[] = [],
  maxRows?: number,
): DbQueryResult {
  const stmt = getDb().prepare(sql);

  // bun:sqlite: columnNames is empty for write statements, populated for SELECT/PRAGMA/EXPLAIN
  if (stmt.columnNames.length === 0) {
    throw new Error("Only read-only queries are allowed");
  }

  const columns = stmt.columnNames as string[];
  const start = performance.now();
  const rows = (params.length > 0 ? stmt.all(...(params as [string])) : stmt.all()) as Record<
    string,
    unknown
  >[];
  const elapsed = Math.round(performance.now() - start);

  const capped = maxRows ? rows.slice(0, maxRows) : rows;
  const rowArrays = capped.map((row) => columns.map((col) => row[col]));

  return { columns, rows: rowArrays, elapsed, total: rows.length };
}

const dbQueryRoute = route({
  method: "post",
  path: "/api/db-query",
  pattern: ["api", "db-query"],
  summary: "Execute a read-only SQL query",
  tags: ["Debug"],
  body: z.object({
    sql: z.string().min(1).max(10_000),
    params: z.array(z.any()).optional().default([]),
  }),
  responses: {
    200: {
      description: "Query results",
      schema: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.any())),
        elapsed: z.number(),
        total: z.number(),
      }),
    },
    400: { description: "Invalid or disallowed SQL" },
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
    const result = executeReadOnlyQuery(parsed.body.sql, parsed.body.params);
    json(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    jsonError(res, message);
  }

  return true;
}
