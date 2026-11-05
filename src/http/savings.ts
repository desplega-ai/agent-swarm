import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getSwarmConfigs, getWorkflow } from "../be/db";
import { computeWorkflowWindow, type SavingsSql, type WorkflowWindow } from "../be/savings/compute";
import {
  type Calibration,
  parseCalibration,
  priceWorkflow,
  SAVINGS_CALIBRATION_KEY,
  SAVINGS_TIERS,
  type SavingsBand,
  SHIPPED_CALIBRATION,
  splitByDay,
} from "../be/savings/model";
import { executeReadOnlyQueryGated } from "./db-query";
import {
  DbQueryConcurrencyCapError,
  DbQueryTimeoutError,
  getDbQueryHttpBudgetMs,
} from "./db-query-shared";
import { route } from "./route-def";
import { json } from "./utils";

/** Live facts are reused for this long, so page views do not rescan the runs. */
const FACTS_TTL_MS = 10 * 60 * 1000;

/**
 * The scans run through the bounded db-query executor: a child process with a
 * wall-clock budget, sharing the swarm-wide db-query concurrency cap, so a
 * burst of requests can neither block the API's event loop nor pile up.
 */
const boundedSql: SavingsSql = async <T>(sql: string, params: unknown[]) => {
  const result = await executeReadOnlyQueryGated(sql, params, getDbQueryHttpBudgetMs(), 10_000);
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, i) => [column, row[i]])),
  ) as T[];
};

const SavingsBandSchema = z.object({ p10: z.number(), p50: z.number(), p90: z.number() });

const SavingsJobRowSchema = z.object({
  kind: z.literal("workflow"),
  workflowId: z.string(),
  name: z.string(),
  basis: z.literal("modelled"),
  runs: z.number().int(),
  substitutedRuns: z.number().int(),
  effectRuns: z.number().int(),
  enabledOnlyRuns: z.number().int(),
  capApplied: z.boolean(),
  opsPerRun: z.number(),
  measuredUsd: z
    .number()
    .describe(
      "Measured spend of every run in the window: agent tasks, their reviews, recorded LLM cost.",
    ),
  estimatedLlmUsd: z
    .number()
    .describe(
      "LLM spend estimated from tokens and output size, not measured. 0 when the runs recorded their LLM cost.",
    ),
  actualUsd: z
    .number()
    .describe(
      "Scaled estimate, not a measurement: `measuredUsd + estimatedLlmUsd` times `substitutedRuns / runs`. The saving subtracts this.",
    ),
  agentOnlyUsd: SavingsBandSchema,
  savingUsd: SavingsBandSchema,
  actualHours: z
    .number()
    .describe("Scaled estimate: measured hours times `substitutedRuns / runs`."),
  agentOnlyHours: SavingsBandSchema,
  hoursSaved: SavingsBandSchema,
  agentOnlyUsdPerRun: z.number(),
});

const SavingsJobsResponseSchema = z.object({
  window: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
  tier: z.enum(SAVINGS_TIERS),
  calibrationModel: z.string(),
  calibratedAt: z.string(),
  /** `shipped`: the constants in the release. `deployment`: derived from this swarm's own sessions. */
  calibrationSource: z.enum(["shipped", "deployment"]),
  computedAt: z.string(),
  /** False when there is nothing to show: no runs, or too many runs to compute live. */
  valid: z.boolean(),
  reason: z.enum(["no-runs", "too-many-runs"]).nullable(),
  rows: z.array(SavingsJobRowSchema),
});

const savingsJobsRoute = route({
  method: "get",
  path: "/api/savings/jobs",
  pattern: ["api", "savings", "jobs"],
  summary: "Estimated automation savings for a workflow",
  description:
    "What the workflow's runs in the window would have cost as agent tasks, minus what they cost. `measuredUsd` is the measured spend and `estimatedLlmUsd` the LLM spend estimated where none was recorded; `actualUsd` is their sum scaled to the substituted share of runs, the estimate the saving subtracts. Modelled at the chosen tier, with an 80% range (p10 to p90). `valid` is false when the workflow had no runs, or more runs than the live computation handles.",
  tags: ["Savings"],
  query: z.object({
    workflowId: z.string().min(1),
    days: z.enum(["7", "30", "90"]).default("30").transform(Number),
    tier: z.enum(SAVINGS_TIERS).default("smart"),
  }),
  responses: {
    200: { description: "Savings rows for the workflow", schema: SavingsJobsResponseSchema },
    400: { description: "Missing workflowId, or an unknown days or tier value" },
    404: { description: "Workflow not found" },
    408: { description: "A savings query ran past its time budget" },
    429: { description: "Too many concurrent database queries; retry shortly" },
  },
});

const SavingsDailyResponseSchema = z.object({
  window: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
  tier: z.enum(SAVINGS_TIERS),
  calibrationModel: z.string(),
  calibratedAt: z.string(),
  calibrationSource: z.enum(["shipped", "deployment"]),
  computedAt: z.string(),
  valid: z.boolean(),
  reason: z.enum(["no-runs", "too-many-runs"]).nullable(),
  /** One point per UTC day in the window, oldest first; empty when not valid. */
  points: z.array(
    z.object({
      day: z.string(),
      /** p50; the points sum to the p50 saving of `/api/savings/jobs`. */
      savingUsd: z.number(),
      /** Scaled estimate; the points sum to the jobs row's `actualUsd`. */
      actualUsd: z
        .number()
        .describe(
          "Scaled estimate: the day's measured and estimated spend times the window's substituted share.",
        ),
      /** Measured; the points sum to the jobs row's `measuredUsd`. */
      measuredUsd: z.number().describe("The day's measured spend, not scaled."),
      /** Estimated; the points sum to the jobs row's `estimatedLlmUsd`. */
      estimatedLlmUsd: z
        .number()
        .describe("The day's LLM spend estimated from tokens and output size, not measured."),
    }),
  ),
});

const savingsDailyRoute = route({
  method: "get",
  path: "/api/savings/daily",
  pattern: ["api", "savings", "daily"],
  summary: "Daily automation savings for a workflow",
  description:
    "The workflow's p50 saving, measured spend and scaled actual cost per UTC day of the window, from the same computation as `/api/savings/jobs`, so the points sum to its p50 saving, `measuredUsd`, `estimatedLlmUsd` and `actualUsd`. When the hourly cap applies, the counted schedule runs are spread pro rata over the days. `valid` is false when the workflow had no runs, or more runs than the live computation handles.",
  tags: ["Savings"],
  query: z.object({
    workflowId: z.string().min(1),
    days: z.enum(["7", "30", "90"]).default("30").transform(Number),
    tier: z.enum(SAVINGS_TIERS).default("smart"),
  }),
  responses: {
    200: {
      description: "Daily savings points for the workflow",
      schema: SavingsDailyResponseSchema,
    },
    400: { description: "Missing workflowId, or an unknown days or tier value" },
    404: { description: "Workflow not found" },
    408: { description: "A savings query ran past its time budget" },
    429: { description: "Too many concurrent database queries; retry shortly" },
  },
});

type CachedFacts = { at: number; start: string; end: string; result: Promise<WorkflowWindow> };
const factsCache = new Map<string, CachedFacts>();

/** The stored deployment curve is re-read this often, so a new calibration shows within a minute. */
const CALIBRATION_TTL_MS = 60 * 1000;
let calibrationCache: { at: number; value: Calibration } | null = null;

async function activeCalibration(now: number): Promise<Calibration> {
  if (calibrationCache && now - calibrationCache.at < CALIBRATION_TTL_MS) {
    return calibrationCache.value;
  }
  const [row] = await getSwarmConfigs({ scope: "global", key: SAVINGS_CALIBRATION_KEY });
  // A malformed row falls back to the shipped curve rather than failing every savings request.
  const value = parseCalibration(row?.value) ?? SHIPPED_CALIBRATION;
  calibrationCache = { at: now, value };
  return value;
}

/** Test hook. */
export function resetSavingsCache(): void {
  factsCache.clear();
  calibrationCache = null;
}

function cachedWindow(
  workflow: { id: string; definition: unknown },
  days: number,
  now: number,
): CachedFacts {
  const key = `${workflow.id}:${days}`;
  const hit = factsCache.get(key);
  if (hit && now - hit.at < FACTS_TTL_MS) return hit;
  const end = new Date(now).toISOString();
  const start = new Date(now - days * 86_400_000).toISOString();
  const entry: CachedFacts = {
    at: now,
    start,
    end,
    result: computeWorkflowWindow(workflow, { start, end }, boundedSql),
  };
  // A failed computation is not cached.
  void entry.result.catch(() => factsCache.delete(key));
  factsCache.set(key, entry);
  return entry;
}

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

/** Every UTC day from `start` to `end`, both inclusive. */
function utcDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start.slice(0, 10)); t <= Date.parse(end); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export async function handleSavings(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  const isJobs = savingsJobsRoute.match(req.method, pathSegments);
  if (!isJobs && !savingsDailyRoute.match(req.method, pathSegments)) return false;
  const parsed = isJobs
    ? await savingsJobsRoute.parse(req, res, pathSegments, queryParams)
    : await savingsDailyRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const { workflowId, days, tier } = parsed.query;
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Workflow not found" }));
    return true;
  }
  const entry = cachedWindow(workflow, days, Date.now());
  let result: WorkflowWindow;
  try {
    result = await entry.result;
  } catch (err) {
    if (err instanceof DbQueryConcurrencyCapError) {
      res.setHeader("Retry-After", "1");
      json(res, { error: "db_query_concurrency_cap", message: err.message }, 429);
      return true;
    }
    if (err instanceof DbQueryTimeoutError) {
      json(res, { error: "db_query_timeout", message: err.message }, 408);
      return true;
    }
    throw err;
  }
  const calibration = await activeCalibration(Date.now());
  const base = {
    window: { start: entry.start, end: entry.end, days },
    tier,
    calibrationModel: calibration.model,
    calibratedAt: calibration.calibratedAt,
    calibrationSource: calibration.source,
    computedAt: new Date(entry.at).toISOString(),
  };
  if (result.status === "too-many-runs" || result.facts.runs === 0) {
    const reason = result.status === "too-many-runs" ? "too-many-runs" : "no-runs";
    if (isJobs) savingsJobsRoute.respond(res, 200, { ...base, valid: false, reason, rows: [] });
    else savingsDailyRoute.respond(res, 200, { ...base, valid: false, reason, points: [] });
    return true;
  }

  if (!isJobs) {
    const split = new Map(
      splitByDay(result.facts, result.byDay, { tier, days, curve: calibration.curve }).map((p) => [
        p.day,
        p,
      ]),
    );
    const dayList = utcDays(entry.start, entry.end);
    const saving = roundToTotal(dayList.map((d) => split.get(d)?.savingUsd ?? 0));
    const actual = roundToTotal(dayList.map((d) => split.get(d)?.actualUsd ?? 0));
    const measured = roundToTotal(dayList.map((d) => split.get(d)?.measuredUsd ?? 0));
    const estimated = roundToTotal(dayList.map((d) => split.get(d)?.estimatedLlmUsd ?? 0));
    savingsDailyRoute.respond(res, 200, {
      ...base,
      valid: true,
      reason: null,
      points: dayList.map((day, i) => ({
        day,
        savingUsd: saving[i] as number,
        actualUsd: actual[i] as number,
        measuredUsd: measured[i] as number,
        estimatedLlmUsd: estimated[i] as number,
      })),
    });
    return true;
  }

  const priced = priceWorkflow(result.facts, { tier, days, band: "job", curve: calibration.curve });
  savingsJobsRoute.respond(res, 200, {
    ...base,
    valid: true,
    reason: null,
    rows: [
      {
        kind: "workflow",
        workflowId: workflow.id,
        name: workflow.name,
        basis: "modelled",
        runs: priced.runs,
        substitutedRuns: priced.substitutedRuns,
        effectRuns: priced.effectRuns,
        enabledOnlyRuns: priced.enabledOnlyRuns,
        capApplied: priced.capApplied,
        opsPerRun: round2(priced.opsPerRun),
        measuredUsd: round2(priced.measuredUsd),
        estimatedLlmUsd: round2(priced.estimatedLlmUsd),
        actualUsd: round2(priced.actualUsd),
        agentOnlyUsd: roundBand(priced.agentOnlyUsd),
        savingUsd: roundBand(priced.savingUsd),
        actualHours: round2(priced.actualHours),
        agentOnlyHours: roundBand(priced.agentOnlyHours),
        hoursSaved: roundBand(priced.hoursSaved),
        agentOnlyUsdPerRun: round2(priced.agentOnlyUsdPerRun),
      },
    ],
  });
  return true;
}
