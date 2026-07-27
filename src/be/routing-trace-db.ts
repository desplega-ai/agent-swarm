import type { RoutingTrace } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getDb } from "./db";

export type RoutingHandlerStats = {
  handlerName: string;
  hits: number;
  decisive: number;
  errors: number;
  deviations: number;
  avgDurationMs: number | null;
  lastHitAt: string | null;
};

interface RoutingTraceRow {
  id: string;
  routingRunId: string;
  taskId: string | null;
  edge: string;
  via: string;
  handlerId: string;
  handlerName: string;
  flavor: string;
  mode: string;
  matched: number;
  resultJson: string | null;
  decisive: number;
  suggestion: string | null;
  deviated: number | null;
  dryRun: number;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

function rowToRoutingTrace(row: RoutingTraceRow): RoutingTrace {
  return {
    id: row.id,
    routingRunId: row.routingRunId,
    taskId: row.taskId ?? undefined,
    edge: row.edge as RoutingTrace["edge"],
    via: row.via as RoutingTrace["via"],
    handlerId: row.handlerId,
    handlerName: row.handlerName,
    flavor: row.flavor as RoutingTrace["flavor"],
    mode: row.mode as RoutingTrace["mode"],
    matched: row.matched === 1,
    result: row.resultJson ? (JSON.parse(row.resultJson) as RoutingTrace["result"]) : undefined,
    decisive: row.decisive === 1,
    suggestion: row.suggestion ?? undefined,
    deviated: row.deviated === null ? undefined : row.deviated === 1,
    dryRun: row.dryRun === 1,
    error: row.error ?? undefined,
    durationMs: row.durationMs ?? undefined,
    createdAt: row.createdAt,
  };
}

export function insertRoutingTrace(
  trace: Omit<RoutingTrace, "id" | "createdAt"> & { id?: string },
): RoutingTrace {
  const id = trace.id ?? crypto.randomUUID();
  // `result` and `suggestion` are raw handler-script output and this table is
  // readable via GET /api/tasks/{id}/routing-trace, so a buggy or hostile
  // handler could park a credential in `note`/`promptDirectives`. Scrub at
  // this persistence egress — same treatment `error` already gets upstream,
  // and it covers every caller rather than just the engine.
  const resultJson = trace.result === undefined ? null : scrubSecrets(JSON.stringify(trace.result));
  getDb()
    .prepare(
      `INSERT INTO routing_trace (
         id, routingRunId, taskId, edge, via, handlerId, handlerName, flavor, mode,
         matched, resultJson, decisive, suggestion, deviated, dryRun, error, durationMs
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      trace.routingRunId,
      trace.taskId ?? null,
      trace.edge,
      trace.via,
      trace.handlerId,
      trace.handlerName,
      trace.flavor,
      trace.mode,
      trace.matched === false ? 0 : 1,
      resultJson,
      trace.decisive ? 1 : 0,
      trace.suggestion === undefined ? null : scrubSecrets(trace.suggestion),
      trace.deviated === undefined ? null : trace.deviated ? 1 : 0,
      trace.dryRun ? 1 : 0,
      trace.error ?? null,
      trace.durationMs ?? null,
    );
  const created = getDb()
    .prepare("SELECT * FROM routing_trace WHERE id = ?")
    .get(id) as RoutingTraceRow | null;
  if (!created) throw new Error("Failed to insert routing trace");
  return rowToRoutingTrace(created);
}

export function backfillTraceTaskId(routingRunId: string, taskId: string): number {
  return getDb()
    .prepare("UPDATE routing_trace SET taskId = ? WHERE routingRunId = ? AND taskId IS NULL")
    .run(taskId, routingRunId).changes;
}

export function listTraceForTask(taskId: string): RoutingTrace[] {
  return (
    getDb()
      .prepare("SELECT * FROM routing_trace WHERE taskId = ? ORDER BY createdAt, rowid")
      .all(taskId) as RoutingTraceRow[]
  ).map(rowToRoutingTrace);
}

export function listTraceForRun(routingRunId: string): RoutingTrace[] {
  return (
    getDb()
      .prepare("SELECT * FROM routing_trace WHERE routingRunId = ? ORDER BY createdAt, rowid")
      .all(routingRunId) as RoutingTraceRow[]
  ).map(rowToRoutingTrace);
}

/** Aggregate non-dry-run trace rows for the routing authoring surfaces. */
export function aggregateHandlerStats({
  windowHours,
}: {
  windowHours?: number;
} = {}): RoutingHandlerStats[] {
  const cutoff = windowHours === undefined ? null : `-${windowHours} hours`;
  return getDb()
    .prepare(
      `SELECT handlerName,
              SUM(matched) AS hits,
              SUM(decisive) AS decisive,
              SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN deviated = 1 THEN 1 ELSE 0 END) AS deviations,
              AVG(durationMs) AS avgDurationMs,
              MAX(createdAt) AS lastHitAt
         FROM routing_trace
        WHERE dryRun = 0
          AND (? IS NULL OR createdAt >= datetime('now', ?))
        GROUP BY handlerName
        ORDER BY handlerName`,
    )
    .all(cutoff, cutoff)
    .map((row) => {
      const stats = row as RoutingHandlerStats;
      return {
        ...stats,
        hits: Number(stats.hits),
        decisive: Number(stats.decisive),
        errors: Number(stats.errors),
        deviations: Number(stats.deviations),
        avgDurationMs: stats.avgDurationMs === null ? null : Number(stats.avgDurationMs),
      };
    });
}
