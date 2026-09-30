/**
 * Query parsing and dispatch for the `/api/analytics/*` suite endpoints. Pure:
 * server.ts does auth and the DB read, this turns query params into a typed query
 * (or a 400 message) and runs the matching aggregator.
 */

import { SUITE_VERSION } from "../../scenarios/suite.ts";
import type { AnalyticsFilter } from "../types.ts";
import { parseFilterCsv } from "./analytics-source.ts";
import {
  buildCompare,
  buildFrontier,
  buildHeatmap,
  buildLeaderboard,
  buildReliability,
  DEFAULT_PASS_K,
  MAX_PASS_K,
  type SuiteAnalyticsInput,
} from "./suite-analytics.ts";

export const SUITE_ANALYTICS_KINDS = [
  "frontier",
  "leaderboard",
  "heatmap",
  "reliability",
  "compare",
] as const;
export type SuiteAnalyticsKind = (typeof SUITE_ANALYTICS_KINDS)[number];

/** Default largest k on the reliability curve (the weekly matrix runs 5 repeats). */
export const DEFAULT_MAX_K = 5;

const SUITE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export interface SuiteQuery {
  suiteVersion: string;
  filter: AnalyticsFilter;
  /** Leaderboard pass^k. */
  k: number;
  /** Reliability curve length. */
  maxK: number;
  /** Compare: the two config ids. */
  a: string | null;
  b: string | null;
}

export type ParsedSuiteQuery = { ok: true; query: SuiteQuery } | { ok: false; error: string };

function parseK(params: URLSearchParams, name: string, fallback: number): number | string {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PASS_K) {
    return `${name} must be an integer from 1 to ${MAX_PASS_K}`;
  }
  return n;
}

export function parseSuiteQuery(
  kind: SuiteAnalyticsKind,
  params: URLSearchParams,
): ParsedSuiteQuery {
  const suiteVersion = params.get("suite")?.trim() || SUITE_VERSION;
  if (!SUITE_VERSION_RE.test(suiteVersion))
    return { ok: false, error: "suite is not a valid version" };
  const k = kind === "leaderboard" ? parseK(params, "k", DEFAULT_PASS_K) : DEFAULT_PASS_K;
  if (typeof k === "string") return { ok: false, error: k };
  const maxK = kind === "reliability" ? parseK(params, "maxK", DEFAULT_MAX_K) : DEFAULT_MAX_K;
  if (typeof maxK === "string") return { ok: false, error: maxK };
  const a = params.get("a")?.trim() || null;
  const b = params.get("b")?.trim() || null;
  if (kind === "compare") {
    if (a === null || b === null)
      return { ok: false, error: "compare needs both a and b (config ids)" };
    if (a === b) return { ok: false, error: "a and b must be different configs" };
  }
  return {
    ok: true,
    query: {
      suiteVersion,
      filter: {
        harnesses: parseFilterCsv(params.get("harnesses")),
        configIds: parseFilterCsv(params.get("configs")),
        efforts: parseFilterCsv(params.get("efforts")),
      },
      k,
      maxK,
      a,
      b,
    },
  };
}

/** Run one aggregator. `input.suiteVersion` and `input.filter` are set from the query. */
export function runSuiteAnalytics(
  kind: SuiteAnalyticsKind,
  query: SuiteQuery,
  input: Omit<SuiteAnalyticsInput, "suiteVersion" | "filter">,
): unknown {
  const full: SuiteAnalyticsInput = {
    ...input,
    suiteVersion: query.suiteVersion,
    filter: query.filter,
  };
  switch (kind) {
    case "frontier":
      return buildFrontier(full);
    case "leaderboard":
      return buildLeaderboard(full, query.k);
    case "heatmap":
      return buildHeatmap(full);
    case "reliability":
      return buildReliability(full, query.maxK);
    case "compare":
      return buildCompare(full, query.a as string, query.b as string);
  }
}

export interface SuiteSummary {
  suiteVersion: string;
  attempts: number;
  runs: number;
  configs: number;
  firstRunAt: string | null;
  lastRunAt: string | null;
}

export interface SuitesResponse {
  /** The suite the code manifest defines today; the default for every endpoint. */
  current: string;
  /** Suites with recorded attempts, newest first. May not include `current` before its first run. */
  suites: SuiteSummary[];
}

/** SUITES_SQL result rows → the `/api/analytics/suites` body. */
export function mapSuitesResponse(rows: Record<string, unknown>[]): SuitesResponse {
  return {
    current: SUITE_VERSION,
    suites: rows.map((r) => ({
      suiteVersion: r.suite_version as string,
      attempts: Number(r.attempts),
      runs: Number(r.runs),
      configs: Number(r.configs),
      firstRunAt: (r.first_run_at as string) ?? null,
      lastRunAt: (r.last_run_at as string) ?? null,
    })),
  };
}
