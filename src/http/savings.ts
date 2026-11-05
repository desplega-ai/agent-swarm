import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getWorkflow } from "../be/db";
import type { DbParam } from "../be/db-client";
import type { SavingsSql } from "../be/savings/compute";
import {
  CALIBRATED_AT,
  CALIBRATION_MODEL,
  type PricedWorkflow,
  SAVINGS_TIERS,
  type SavingsBand,
} from "../be/savings/model";
import { readWorkflowSavings, type SavingsTotals } from "../be/savings/read";
import { refreshWorkflowToday } from "../be/savings/rollup";
import { executeReadOnlyQueryGated } from "./db-query";
import {
  DbQueryConcurrencyCapError,
  DbQueryTimeoutError,
  getDbQueryHttpBudgetMs,
} from "./db-query-shared";
import { route } from "./route-def";
import { json } from "./utils";

/**
 * The scans run through the bounded db-query executor: a child process with a
 * wall-clock budget, sharing the swarm-wide db-query concurrency cap, so they
 * can neither block the API's event loop nor pile up.
 */
function boundedSql(budgetMs: () => number): SavingsSql {
  return async <T>(sql: string, params: DbParam[]) => {
    const result = await executeReadOnlyQueryGated(sql, params, budgetMs(), 10_000);
    return result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column, i) => [column, row[i]])),
    ) as T[];
  };
}

/** Request-path scans (today's bucket of one workflow) use the HTTP db-query budget. */
const requestSql = boundedSql(getDbQueryHttpBudgetMs);

/** The router's step scan for one day takes about 10 s. */
const ROLLUP_QUERY_BUDGET_MS = 60_000;

/**
 * Scans of the hourly rollup. They run in the background, so a full
 * concurrency cap is waited out (up to about a minute) instead of failing the day.
 */
export const savingsRollupSql: SavingsSql = async <T>(sql: string, params: DbParam[]) => {
  const run = boundedSql(() => ROLLUP_QUERY_BUDGET_MS);
  for (let attempt = 1; ; attempt++) {
    try {
      return await run<T>(sql, params);
    } catch (err) {
      if (!(err instanceof DbQueryConcurrencyCapError) || attempt >= 20) throw err;
      await Bun.sleep(Math.min(5_000, 250 * attempt));
    }
  }
};

const SavingsBandSchema = z.object({ p10: z.number(), p50: z.number(), p90: z.number() });

const SavingsJobRowSchema = z.object({
  kind: z.literal("workflow"),
  workflowId: z.string(),
  name: z.string(),
  basis: z.literal("modelled"),
  /** True when the enabled-only rule priced only the runs with a downstream effect (an event router). */
  enabledOnlyRule: z.boolean(),
  runs: z.number().int(),
  substitutedRuns: z.number().int(),
  effectRuns: z.number().int(),
  enabledOnlyRuns: z.number().int(),
  capApplied: z.boolean(),
  opsPerRun: z.number(),
  actualUsd: z.number(),
  agentOnlyUsd: SavingsBandSchema,
  savingUsd: SavingsBandSchema,
  actualHours: z.number(),
  agentOnlyHours: SavingsBandSchema,
  hoursSaved: SavingsBandSchema,
  agentOnlyUsdPerRun: z.number(),
});

const SavingsTotalsSchema = z.object({
  runs: z.number().int(),
  substitutedRuns: z.number().int(),
  enabledOnlyRuns: z.number().int(),
  actualUsd: z.number(),
  agentOnlyUsd: SavingsBandSchema,
  savingUsd: SavingsBandSchema,
  actualHours: z.number(),
  hoursSaved: SavingsBandSchema,
});

const savingsMeta = {
  window: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
  tier: z.enum(SAVINGS_TIERS),
  calibrationModel: z.string(),
  calibratedAt: z.string(),
  /** Newest rollup time of the window's days; null before the first rollup. */
  computedAt: z.string().nullable(),
  /** False when there is nothing to show: the window is not computed yet, or had no runs. Never $0. */
  valid: z.boolean(),
  reason: z.enum(["not-computed", "no-runs"]).nullable(),
};

const SavingsJobsResponseSchema = z.object({
  ...savingsMeta,
  rows: z.array(SavingsJobRowSchema),
  /** Sum of `rows`; the band is the single-job spread for one row and the fleet spread for more. */
  total: SavingsTotalsSchema.nullable(),
});

const SavingsDailyResponseSchema = z.object({
  ...savingsMeta,
  /** p50 per UTC day, oldest first. The points add up to the window's p50 saving and actual cost. */
  points: z.array(z.object({ day: z.string(), savingUsd: z.number(), actualUsd: z.number() })),
});

const windowQuery = {
  days: z.enum(["7", "30", "90"]).default("30").transform(Number),
  tier: z.enum(SAVINGS_TIERS).default("smart"),
};

const savingsJobsRoute = route({
  method: "get",
  path: "/api/savings/jobs",
  pattern: ["api", "savings", "jobs"],
  summary: "Estimated automation savings per workflow",
  description:
    "What the workflows' runs in the window would have cost as agent tasks, minus what they cost, read from the hourly savings rollup. Modelled at the chosen tier, with an 80% range (p10 to p90). Pass `workflowId` for one workflow or `kind=workflow` for every workflow with runs. `valid` is false until the rollup has computed every day of the window, and when there were no runs.",
  tags: ["Savings"],
  query: z.object({
    workflowId: z.string().min(1).optional(),
    kind: z.enum(["workflow"]).optional(),
    ...windowQuery,
  }),
  responses: {
    200: { description: "Savings rows", schema: SavingsJobsResponseSchema },
    400: { description: "Neither workflowId nor kind, or an unknown days or tier value" },
    404: { description: "Workflow not found" },
  },
});

const savingsDailyRoute = route({
  method: "get",
  path: "/api/savings/daily",
  pattern: ["api", "savings", "daily"],
  summary: "Daily automation savings of a workflow",
  description:
    "The workflow's p50 saving and actual cost per UTC day of the window, from the hourly savings rollup. The points add up to the window figures of `GET /api/savings/jobs?workflowId=`.",
  tags: ["Savings"],
  query: z.object({ workflowId: z.string().min(1), ...windowQuery }),
  responses: {
    200: { description: "Daily savings points", schema: SavingsDailyResponseSchema },
    400: { description: "Missing workflowId, or an unknown days or tier value" },
    404: { description: "Workflow not found" },
  },
});

const round2 = (x: number) => Math.round(x * 100) / 100;
const roundBand = (b: SavingsBand): SavingsBand => ({
  p10: round2(b.p10),
  p50: round2(b.p50),
  p90: round2(b.p90),
});

/**
 * Round each value to cents so the rounded values sum to the rounded total
 * (largest remainder), keeping the chart equal to the header amount.
 */
export function roundToTotal(values: number[]): number[] {
  const cents = values.map((v) => v * 100);
  const floors = cents.map(Math.floor);
  let left = Math.round(cents.reduce((s, c) => s + c, 0)) - floors.reduce((s, c) => s + c, 0);
  const order = cents
    .map((c, i) => ({ i, r: c - (floors[i] as number) }))
    .sort((a, b) => b.r - a.r);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] as number) + 1;
    left--;
  }
  return floors.map((c) => c / 100);
}

function toRow(row: PricedWorkflow & { workflowId: string; name: string }) {
  return {
    kind: "workflow" as const,
    workflowId: row.workflowId,
    name: row.name,
    basis: "modelled" as const,
    enabledOnlyRule: row.enabledOnlyRule,
    runs: row.runs,
    substitutedRuns: row.substitutedRuns,
    effectRuns: row.effectRuns,
    enabledOnlyRuns: row.enabledOnlyRuns,
    capApplied: row.capApplied,
    opsPerRun: round2(row.opsPerRun),
    actualUsd: round2(row.actualUsd),
    agentOnlyUsd: roundBand(row.agentOnlyUsd),
    savingUsd: roundBand(row.savingUsd),
    actualHours: round2(row.actualHours),
    agentOnlyHours: roundBand(row.agentOnlyHours),
    hoursSaved: roundBand(row.hoursSaved),
    agentOnlyUsdPerRun: round2(row.agentOnlyUsdPerRun),
  };
}

function toTotals(t: SavingsTotals) {
  return {
    ...t,
    actualUsd: round2(t.actualUsd),
    agentOnlyUsd: roundBand(t.agentOnlyUsd),
    savingUsd: roundBand(t.savingUsd),
    actualHours: round2(t.actualHours),
    hoursSaved: roundBand(t.hoursSaved),
  };
}

function notFound(res: ServerResponse): true {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Workflow not found" }));
  return true;
}

/**
 * One workflow: bring today's bucket up to date first when it has a run newer
 * than the last rollup. Best effort: on a busy database the hourly bucket is served.
 */
async function readOne(workflowId: string, days: number, tier: (typeof SAVINGS_TIERS)[number]) {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) return null;
  const now = Date.now();
  try {
    await refreshWorkflowToday(workflow, requestSql, now);
  } catch (err) {
    if (!(err instanceof DbQueryConcurrencyCapError || err instanceof DbQueryTimeoutError))
      throw err;
  }
  return readWorkflowSavings({ days, tier, now, workflowId });
}

function meta(
  read: { window: { start: string; end: string; days: number }; computedAt: string | null },
  tier: (typeof SAVINGS_TIERS)[number],
  valid: { complete: boolean; hasRows: boolean },
) {
  return {
    window: read.window,
    tier,
    calibrationModel: CALIBRATION_MODEL,
    calibratedAt: CALIBRATED_AT,
    computedAt: read.computedAt,
    valid: valid.complete && valid.hasRows,
    reason: !valid.complete
      ? ("not-computed" as const)
      : valid.hasRows
        ? null
        : ("no-runs" as const),
  };
}

export async function handleSavings(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (savingsDailyRoute.match(req.method, pathSegments)) {
    const parsed = await savingsDailyRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { workflowId, days, tier } = parsed.query;
    const read = await readOne(workflowId, days, tier);
    if (!read) return notFound(res);
    const hasRows = read.rows.length > 0;
    const points = read.complete && hasRows ? read.points : [];
    const saving = roundToTotal(points.map((p) => p.savingUsd));
    const actual = roundToTotal(points.map((p) => p.actualUsd));
    savingsDailyRoute.respond(res, 200, {
      ...meta(read, tier, { complete: read.complete, hasRows }),
      points: points.map((p, i) => ({
        day: p.day,
        savingUsd: saving[i] as number,
        actualUsd: actual[i] as number,
      })),
    });
    return true;
  }

  if (!savingsJobsRoute.match(req.method, pathSegments)) return false;
  const parsed = await savingsJobsRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const { workflowId, kind, days, tier } = parsed.query;
  if (!workflowId && !kind) {
    json(res, { error: "Pass workflowId or kind=workflow" }, 400);
    return true;
  }
  const read = workflowId
    ? await readOne(workflowId, days, tier)
    : await readWorkflowSavings({ days, tier, now: Date.now() });
  if (!read) return notFound(res);
  const show = read.complete;
  savingsJobsRoute.respond(res, 200, {
    ...meta(read, tier, { complete: read.complete, hasRows: read.rows.length > 0 }),
    rows: show ? read.rows.map(toRow) : [],
    total: show && read.total ? toTotals(read.total) : null,
  });
  return true;
}
