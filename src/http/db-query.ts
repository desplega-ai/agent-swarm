import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../be/db";
import { json, jsonError, matchRoute, parseBody } from "./utils";

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

export async function handleDbQuery(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (!matchRoute(req.method, pathSegments, "POST", ["api", "db-query"], true)) {
    return false;
  }

  let body: { sql?: string; params?: unknown[] };
  try {
    body = await parseBody(req);
  } catch {
    jsonError(res, "Invalid JSON body");
    return true;
  }

  if (!body.sql || typeof body.sql !== "string" || body.sql.length === 0) {
    jsonError(res, "Missing or empty 'sql' field");
    return true;
  }

  if (body.sql.length > 10_000) {
    jsonError(res, "SQL query too long (max 10,000 characters)");
    return true;
  }

  try {
    const result = executeReadOnlyQuery(body.sql, body.params ?? []);
    json(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    jsonError(res, message);
  }

  return true;
}
