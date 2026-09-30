/**
 * The attempts x runs query behind every analytics endpoint, its row mapper and
 * the query-param helpers. Lives apart from server.ts so the pure analytics
 * modules and the HTTP layer can share it without an import cycle.
 */

import type { AnalyticsSourceRow } from "./analytics.ts";

/**
 * Analytics source query (v5 spec §1.1 + v7 §6.1 token columns). json_valid
 * guards keep malformed/empty JSON columns from failing the whole aggregation —
 * they degrade to NULL like every other missing field on old rows.
 *
 * worker_version reads BOTH sandboxJson shapes (v6 spec §0.3): legacy v1 blobs
 * store a flat `workerVersion`; v2 blobs store per-worker `workers[].version`
 * (worker 0 is representative — workers are homogeneous within an attempt).
 * Mirrors computeRunVersions() in server.ts.
 */
const ANALYTICS_SELECT = `
  SELECT a.run_id, a.scenario_id, a.config_id, a.status, a.exclusion, a.score, a.cost_usd, a.cost_source,
         a.judge_cost_usd, a.duration_ms,
         CASE WHEN json_valid(a.timings_json)
              THEN json_extract(a.timings_json, '$.tasksMs') END     AS agent_ms,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.model') END        AS token_model,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.inputTokens') END  AS token_input,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.outputTokens') END AS token_output,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.cacheReadTokens') END  AS token_cache_read,
         CASE WHEN json_valid(a.tokens_json)
              THEN json_extract(a.tokens_json, '$.cacheWriteTokens') END AS token_cache_write,
         CASE WHEN json_valid(a.sandbox_json)
              THEN json_extract(a.sandbox_json, '$.apiVersion') END  AS api_version,
         CASE WHEN json_valid(a.sandbox_json)
              THEN COALESCE(
                json_extract(a.sandbox_json, '$.workerVersion'),
                json_extract(a.sandbox_json, '$.workers[0].version')
              ) END AS worker_version,
         r.name AS run_name, r.created_at AS run_created_at,
         a.resolved_model, a.reasoning_effort, a.suite_version, rc.resolved_model AS pinned_model
  FROM attempts a JOIN eval_runs r ON r.id = a.run_id
  LEFT JOIN eval_run_configs rc ON rc.run_id = a.run_id AND rc.config_id = a.config_id`;

const ANALYTICS_ORDER = " ORDER BY r.created_at ASC, a.attempt_index ASC";

/** Suites with recorded attempts (bind nothing). Cancelled attempts are not counted. */
export const SUITES_SQL = `
  SELECT a.suite_version AS suite_version, COUNT(*) AS attempts,
         COUNT(DISTINCT a.run_id) AS runs, COUNT(DISTINCT a.config_id) AS configs,
         MIN(r.created_at) AS first_run_at, MAX(r.created_at) AS last_run_at
  FROM attempts a JOIN eval_runs r ON r.id = a.run_id
  WHERE a.suite_version IS NOT NULL AND (a.exclusion IS NULL OR a.exclusion != 'cancelled')
  GROUP BY a.suite_version
  ORDER BY last_run_at DESC, a.suite_version DESC`;

/** Every attempt, oldest run first. */
export const ANALYTICS_SQL = `${ANALYTICS_SELECT}${ANALYTICS_ORDER}`;

/** Only the attempts of one suite version (bind `?` = the suite version). */
export const SUITE_ANALYTICS_SQL = `${ANALYTICS_SELECT} WHERE a.suite_version = ?${ANALYTICS_ORDER}`;

/** Defensive numeric read off a SQL/JSON value — null instead of NaN, always. */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * CSV filter query param (v7.6 §C3 — frozen wire rule): split on ",", trim,
 * drop empties, dedupe. Absent param → [] (no filter on that axis).
 */
export function parseFilterCsv(value: string | null): string[] {
  if (value === null) return [];
  const out: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** One ANALYTICS_SQL result row → the pure aggregators' input. */
export function mapAnalyticsRow(r: Record<string, unknown>): AnalyticsSourceRow {
  return {
    runId: r.run_id as string,
    scenarioId: r.scenario_id as string,
    configId: r.config_id as string,
    status: r.status as string,
    exclusion: (r.exclusion as string) ?? null,
    score: r.score === null ? null : Number(r.score),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    costSource: (r.cost_source as string) ?? null,
    judgeCostUsd: r.judge_cost_usd === null ? null : Number(r.judge_cost_usd),
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    agentMs: numOrNull(r.agent_ms),
    resolvedModel: (r.resolved_model as string) ?? null,
    reasoningEffort: (r.reasoning_effort as string) ?? null,
    suiteVersion: (r.suite_version as string) ?? null,
    pinnedModel: (r.pinned_model as string) ?? null,
    tokenModel: (r.token_model as string) ?? null,
    // v7 §6.1: token sums; numOrNull guards stored-JSON garbage (no NaN).
    tokenInput: numOrNull(r.token_input),
    tokenOutput: numOrNull(r.token_output),
    tokenCacheRead: numOrNull(r.token_cache_read),
    tokenCacheWrite: numOrNull(r.token_cache_write),
    apiVersion: (r.api_version as string) ?? null,
    workerVersion: (r.worker_version as string) ?? null,
    runName: (r.run_name as string) ?? null,
    runCreatedAt: r.run_created_at as string,
  };
}
