/**
 * `GET /api/analytics/cell`: the attempts behind one heatmap cell (one suite
 * version x scenario x config). The heatmap shows a pass fraction; this lists the
 * attempts that make it up so a reader can open one and read its transcript.
 *
 * Counts follow the same rules as `/api/analytics/heatmap`: a cancelled attempt is
 * dropped, `passed` and `failed` are graded, and `error` is counted apart (it is
 * never scored). A `harness-error` attempt therefore shows here as an error, not
 * as a failure of the model.
 */

import { SUITE_VERSION } from "../../scenarios/suite.ts";
import { numOrNull } from "./analytics-source.ts";

/** Most attempts one cell returns. A weekly matrix runs 5 repeats; this leaves room for history. */
export const CELL_ATTEMPT_LIMIT = 100;

const SUITE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** Bind order: suite version, scenario id, config id, limit. */
export const CELL_ATTEMPTS_SQL = `
  SELECT a.id, a.run_id, r.name AS run_name, r.created_at AS run_created_at, a.attempt_index,
         a.status, a.exclusion, a.score, a.cost_usd, a.duration_ms, a.started_at, a.error,
         a.resolved_model, a.reasoning_effort,
         CASE WHEN json_valid(a.timings_json)
              THEN json_extract(a.timings_json, '$.tasksMs') END AS agent_ms
  FROM attempts a JOIN eval_runs r ON r.id = a.run_id
  WHERE a.suite_version = ? AND a.scenario_id = ? AND a.config_id = ?
    AND (a.exclusion IS NULL OR a.exclusion != 'cancelled')
  ORDER BY r.created_at DESC, a.attempt_index ASC
  LIMIT ?`;

export interface CellAttempt {
  id: string;
  runId: string;
  runName: string | null;
  runCreatedAt: string;
  attemptIndex: number;
  status: string;
  /** `harness-error` for an attempt that carries no signal about the model. */
  exclusion: string | null;
  score: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** Time the agent worked, sandbox boot and seeding excluded. */
  agentMs: number | null;
  startedAt: string | null;
  /** Runner error text for an `error` attempt; null otherwise. */
  error: string | null;
  resolvedModel: string | null;
  reasoningEffort: string | null;
}

export interface CellResponse {
  suiteVersion: string;
  scenarioId: string;
  configId: string;
  graded: number;
  passed: number;
  failed: number;
  /** Attempts that never produced a score. Not counted in `graded`. */
  errors: number;
  /** Newest run first, then attempt index. */
  attempts: CellAttempt[];
  /** True when more attempts exist than `CELL_ATTEMPT_LIMIT` returned. */
  truncated: boolean;
}

export interface CellQuery {
  suiteVersion: string;
  scenarioId: string;
  configId: string;
}

export type ParsedCellQuery = { ok: true; query: CellQuery } | { ok: false; error: string };

export function parseCellQuery(params: URLSearchParams): ParsedCellQuery {
  const suiteVersion = params.get("suite")?.trim() || SUITE_VERSION;
  if (!SUITE_VERSION_RE.test(suiteVersion))
    return { ok: false, error: "suite is not a valid version" };
  const scenarioId = params.get("scenario")?.trim() ?? "";
  const configId = params.get("config")?.trim() ?? "";
  if (scenarioId === "" || configId === "")
    return { ok: false, error: "cell needs both scenario and config" };
  return { ok: true, query: { suiteVersion, scenarioId, configId } };
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function mapCellAttempt(r: Record<string, unknown>): CellAttempt {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    runName: str(r.run_name),
    runCreatedAt: String(r.run_created_at),
    attemptIndex: Number(r.attempt_index),
    status: String(r.status),
    exclusion: str(r.exclusion),
    score: numOrNull(r.score),
    costUsd: numOrNull(r.cost_usd),
    durationMs: numOrNull(r.duration_ms),
    agentMs: numOrNull(r.agent_ms),
    startedAt: str(r.started_at),
    error: str(r.error),
    resolvedModel: str(r.resolved_model),
    reasoningEffort: str(r.reasoning_effort),
  };
}

/** Shape the rows of `CELL_ATTEMPTS_SQL` (queried with `CELL_ATTEMPT_LIMIT + 1`) into the response. */
export function buildCell(query: CellQuery, rows: Record<string, unknown>[]): CellResponse {
  const truncated = rows.length > CELL_ATTEMPT_LIMIT;
  const attempts = rows.slice(0, CELL_ATTEMPT_LIMIT).map(mapCellAttempt);
  const passed = attempts.filter((a) => a.status === "passed").length;
  const failed = attempts.filter((a) => a.status === "failed").length;
  return {
    ...query,
    graded: passed + failed,
    passed,
    failed,
    errors: attempts.filter((a) => a.status === "error").length,
    attempts,
    truncated,
  };
}
