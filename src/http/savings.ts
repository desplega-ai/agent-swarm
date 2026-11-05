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
import {
  isKnownScriptName,
  readScriptSavings,
  readWorkflowComponents,
  readWorkflowSavings,
  type SavingsComponent,
  type SavingsTotals,
  type WorkflowSavingsRead,
} from "../be/savings/read";
import { refreshWorkflowToday, utcDay } from "../be/savings/rollup";
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
  /**
   * `script-scheduled`: a schedule targets the script, priced as a standalone
   * agent task. `script-agent-invoked`: priced as the extra turns it adds to
   * the calling agent's session.
   */
  kind: z.enum(["workflow", "script-scheduled", "script-agent-invoked"]),
  /** Set on workflow rows. */
  workflowId: z.string().optional(),
  /** Set on script rows. Scripts are keyed by name across scopes. */
  scriptName: z.string().optional(),
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
    .describe(
      "Scaled estimate: measured hours times `substitutedRuns / runs`. Always 0 for scripts, which keep no agent active.",
    ),
  agentOnlyHours: SavingsBandSchema,
  hoursSaved: SavingsBandSchema,
  agentOnlyUsdPerRun: z.number(),
});

const SavingsTotalsSchema = z.object({
  runs: z.number().int(),
  substitutedRuns: z.number().int(),
  enabledOnlyRuns: z.number().int(),
  measuredUsd: z.number(),
  estimatedLlmUsd: z.number(),
  actualUsd: z.number(),
  agentOnlyUsd: SavingsBandSchema,
  savingUsd: SavingsBandSchema,
  actualHours: z.number(),
  hoursSaved: SavingsBandSchema,
});

const SavingsComponentSchema = z.object({
  kind: z.enum(["workflow", "script", "task"]),
  workflowId: z.string().optional(),
  scriptName: z.string().optional(),
  name: z.string(),
  /**
   * `sub-workflow`: a sub-workflow node's child run. `step-workflow`,
   * `step-script`, `step-task`: a run, nested script run or task a
   * swarm-script step made. `descendant-task`: a task below an agent-task node's task.
   */
  linkKind: z.enum([
    "sub-workflow",
    "step-workflow",
    "step-script",
    "step-task",
    "descendant-task",
  ]),
  /** 1 for a direct child of the workflow. */
  depth: z.number().int(),
  runs: z
    .number()
    .describe("Runs (tasks for a task component) in this tree. Fractional below the first level."),
  actualUsd: z.number(),
  agentOnlyUsd: SavingsBandSchema,
  savingUsd: SavingsBandSchema,
  hoursSaved: SavingsBandSchema,
  inOwnRow: z
    .boolean()
    .describe(
      "True for unowned tasks: their spend is already in the workflow's own row, on both sides, and adds nothing to `withComponents`.",
    ),
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
  /** With `components=true`: what the workflow's runs caused, each priced as on its own row. */
  components: z.array(SavingsComponentSchema).optional(),
  /**
   * With `components=true`: own runs plus every component. Each component is
   * already counted on its own row, so never add this to a list or fleet total.
   */
  withComponents: SavingsTotalsSchema.nullable().optional(),
});

const SavingsDailyResponseSchema = z.object({
  ...savingsMeta,
  /** p50 per UTC day, oldest first. The points add up to the window's p50 saving and actual cost. */
  points: z.array(
    z.object({
      day: z.string(),
      savingUsd: z.number(),
      actualUsd: z
        .number()
        .describe(
          "Scaled estimate: the day's measured and estimated spend times the window's substituted share.",
        ),
      measuredUsd: z.number().describe("The day's measured spend, not scaled."),
      /** Estimated; the points sum to the jobs row's `estimatedLlmUsd`. */
      estimatedLlmUsd: z
        .number()
        .describe("The day's LLM spend estimated from tokens and output size, not measured."),
    }),
  ),
});

const windowQuery = {
  days: z.enum(["7", "30", "90"]).default("30").transform(Number),
  tier: z.enum(SAVINGS_TIERS).default("smart"),
};

const savingsJobsRoute = route({
  method: "get",
  path: "/api/savings/jobs",
  pattern: ["api", "savings", "jobs"],
  summary: "Estimated automation savings per workflow or script",
  description:
    "What the workflows' or scripts' runs in the window would have cost as agent tasks, minus what they cost, read from the hourly savings rollup. With `workflowId` and `components=true`, also returns the workflow's components (child workflow runs, nested script runs and tasks its runs caused, recursively) priced as on their own rows, and `withComponents`, own runs plus those; lists reject `components=true`. `measuredUsd` is the measured spend and `estimatedLlmUsd` the LLM spend estimated where none was recorded; `actualUsd` is their sum scaled to the substituted share of runs, the estimate the saving subtracts. Modelled at the chosen tier, with an 80% range (p10 to p90). Pass `workflowId` for one workflow, `scriptName` for one script, or `kind=workflow` / `kind=script` for every workflow or script with runs. Scheduled scripts are priced as standalone agent tasks; other scripts as the extra turns they add to the calling agent's session. Scripts record no LLM spend, so their spend fields are 0. `valid` is false until the rollup has computed every day of the window, and when there were no runs.",
  tags: ["Savings"],
  query: z.object({
    workflowId: z.string().min(1).optional(),
    scriptName: z.string().min(1).optional(),
    kind: z.enum(["workflow", "script"]).optional(),
    components: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    ...windowQuery,
  }),
  responses: {
    200: { description: "Savings rows", schema: SavingsJobsResponseSchema },
    400: {
      description:
        "Not exactly one of workflowId, scriptName and kind, `components=true` without workflowId, or an unknown days or tier value",
    },
    404: { description: "Workflow or script not found" },
  },
});

const savingsDailyRoute = route({
  method: "get",
  path: "/api/savings/daily",
  pattern: ["api", "savings", "daily"],
  summary: "Daily automation savings of a workflow or script",
  description:
    "The workflow's or script's p50 saving, measured spend, estimated LLM spend and scaled actual cost per UTC day of the window, from the hourly savings rollup. The points add up to the window figures of `GET /api/savings/jobs` for the same `workflowId` or `scriptName`.",
  tags: ["Savings"],
  query: z.object({
    workflowId: z.string().min(1).optional(),
    scriptName: z.string().min(1).optional(),
    ...windowQuery,
  }),
  responses: {
    200: { description: "Daily savings points", schema: SavingsDailyResponseSchema },
    400: {
      description: "Not exactly one of workflowId and scriptName, or an unknown days or tier value",
    },
    404: { description: "Workflow or script not found" },
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

type ReadRow = PricedWorkflow & { name: string } & (
    | { workflowId: string; kind?: undefined }
    | { scriptName: string; kind: "script-scheduled" | "script-agent-invoked" }
  );

function toRow(row: ReadRow) {
  return {
    ...("workflowId" in row
      ? { kind: "workflow" as const, workflowId: row.workflowId }
      : { kind: row.kind, scriptName: row.scriptName }),
    name: row.name,
    basis: "modelled" as const,
    enabledOnlyRule: row.enabledOnlyRule,
    runs: row.runs,
    substitutedRuns: row.substitutedRuns,
    effectRuns: row.effectRuns,
    enabledOnlyRuns: row.enabledOnlyRuns,
    capApplied: row.capApplied,
    opsPerRun: round2(row.opsPerRun),
    measuredUsd: round2(row.measuredUsd),
    estimatedLlmUsd: round2(row.estimatedLlmUsd),
    actualUsd: round2(row.actualUsd),
    agentOnlyUsd: roundBand(row.agentOnlyUsd),
    savingUsd: roundBand(row.savingUsd),
    actualHours: round2(row.actualHours),
    agentOnlyHours: roundBand(row.agentOnlyHours),
    hoursSaved: roundBand(row.hoursSaved),
    agentOnlyUsdPerRun: round2(row.agentOnlyUsdPerRun),
  };
}

function toComponent(c: SavingsComponent) {
  return {
    ...c,
    runs: round2(c.runs),
    actualUsd: round2(c.actualUsd),
    agentOnlyUsd: roundBand(c.agentOnlyUsd),
    savingUsd: roundBand(c.savingUsd),
    hoursSaved: roundBand(c.hoursSaved),
  };
}

function toTotals(t: SavingsTotals) {
  return {
    ...t,
    // A component's share of a child's runs is fractional below the first level.
    runs: Math.round(t.runs),
    substitutedRuns: Math.round(t.substitutedRuns),
    enabledOnlyRuns: Math.round(t.enabledOnlyRuns),
    measuredUsd: round2(t.measuredUsd),
    estimatedLlmUsd: round2(t.estimatedLlmUsd),
    actualUsd: round2(t.actualUsd),
    agentOnlyUsd: roundBand(t.agentOnlyUsd),
    savingUsd: roundBand(t.savingUsd),
    actualHours: round2(t.actualHours),
    hoursSaved: roundBand(t.hoursSaved),
  };
}

function notFound(res: ServerResponse, what: "Workflow" | "Script" = "Workflow"): true {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `${what} not found` }));
  return true;
}

/**
 * One script. No on-request refresh: the hourly bucket is served.
 * shortcut: scripts skip the workflow page's live refresh of today's bucket
 * (an agent-invoked script can run thousands of times a day and its effect
 * probe is a LIKE scan); add one if a detail page needs minute-fresh numbers.
 */
async function readScript(scriptName: string, days: number, tier: (typeof SAVINGS_TIERS)[number]) {
  if (!(await isKnownScriptName(scriptName))) return null;
  return readScriptSavings({ days, tier, now: Date.now(), scriptName });
}

function badTarget(res: ServerResponse, message: string): true {
  json(res, { error: message }, 400);
  return true;
}

/** After a refresh scanned the day, later reads within this long reuse it. */
export const REFRESH_TTL_MS = 60_000;

/**
 * Refresh state per workflow and UTC day. Concurrent reads share the refresh in
 * flight. Once one has scanned the day (computed, refused as too many runs, or
 * stopped by a busy database), reads skip the refresh for REFRESH_TTL_MS, so a
 * burst or a high-volume workflow scans at most once a minute. A refresh that
 * found no newer run did no scan and is not held.
 */
const inFlight = new Map<string, Promise<void>>();
/** When a refresh last scanned the day, per workflow and UTC day. */
const scannedAt = new Map<string, number>();

/** Test hook: forget the refresh state. */
export function resetSavingsRefreshCache(): void {
  inFlight.clear();
  scannedAt.clear();
}

function refreshToday(
  workflow: Parameters<typeof refreshWorkflowToday>[0],
  now: number,
): Promise<void> {
  const key = `${workflow.id}:${utcDay(now)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const at = scannedAt.get(key);
  if (at !== undefined && now - at < REFRESH_TTL_MS) return Promise.resolve();
  for (const [k, t] of scannedAt) if (now - t >= REFRESH_TTL_MS) scannedAt.delete(k);
  const done = refreshWorkflowToday(workflow, requestSql, now)
    .then(
      (outcome) => {
        if (outcome !== "skipped") scannedAt.set(key, Date.now());
      },
      (err) => {
        if (!(err instanceof DbQueryConcurrencyCapError || err instanceof DbQueryTimeoutError))
          throw err;
        scannedAt.set(key, Date.now());
      },
    )
    .finally(() => inFlight.delete(key));
  inFlight.set(key, done);
  return done;
}

/**
 * One workflow: bring today's bucket up to date first when it has a run newer
 * than the last rollup. Best effort: on a busy database the hourly bucket is served.
 */
async function readOne(workflowId: string, days: number, tier: (typeof SAVINGS_TIERS)[number]) {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) return null;
  const now = Date.now();
  await refreshToday(workflow, now);
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
    const { workflowId, scriptName, days, tier } = parsed.query;
    if (!workflowId === !scriptName) return badTarget(res, "Pass workflowId or scriptName");
    const read = workflowId
      ? await readOne(workflowId, days, tier)
      : await readScript(scriptName as string, days, tier);
    if (!read) return notFound(res, workflowId ? "Workflow" : "Script");
    const hasRows = read.rows.length > 0;
    const points = read.complete && hasRows ? read.points : [];
    const saving = roundToTotal(points.map((p) => p.savingUsd));
    const actual = roundToTotal(points.map((p) => p.actualUsd));
    const measured = roundToTotal(points.map((p) => p.measuredUsd));
    const estimated = roundToTotal(points.map((p) => p.estimatedLlmUsd));
    savingsDailyRoute.respond(res, 200, {
      ...meta(read, tier, { complete: read.complete, hasRows }),
      points: points.map((p, i) => ({
        day: p.day,
        savingUsd: saving[i] as number,
        actualUsd: actual[i] as number,
        measuredUsd: measured[i] as number,
        estimatedLlmUsd: estimated[i] as number,
      })),
    });
    return true;
  }

  if (!savingsJobsRoute.match(req.method, pathSegments)) return false;
  const parsed = await savingsJobsRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const { workflowId, scriptName, kind, days, tier, components } = parsed.query;
  if ([workflowId, scriptName, kind].filter(Boolean).length !== 1) {
    return badTarget(res, "Pass one of workflowId, scriptName, kind=workflow or kind=script");
  }
  if (components && !workflowId) {
    return badTarget(res, "components=true needs workflowId; lists count own runs only");
  }
  const read: (Omit<WorkflowSavingsRead, "rows"> & { rows: ReadRow[] }) | null = workflowId
    ? await readOne(workflowId, days, tier)
    : scriptName
      ? await readScript(scriptName, days, tier)
      : kind === "script"
        ? await readScriptSavings({ days, tier, now: Date.now() })
        : await readWorkflowSavings({ days, tier, now: Date.now() });
  if (!read) return notFound(res, scriptName ? "Script" : "Workflow");
  const show = read.complete;
  const own = show && workflowId ? read.rows[0] : undefined;
  const tree =
    components && own && "workflowId" in own
      ? await readWorkflowComponents({
          days,
          tier,
          now: Date.now(),
          workflowId: own.workflowId,
          own,
        })
      : null;
  savingsJobsRoute.respond(res, 200, {
    ...meta(read, tier, { complete: read.complete, hasRows: read.rows.length > 0 }),
    rows: show ? read.rows.map(toRow) : [],
    total: show && read.total ? toTotals(read.total) : null,
    ...(components
      ? {
          components: tree ? tree.components.map(toComponent) : [],
          withComponents: tree?.withComponents ? toTotals(tree.withComponents) : null,
        }
      : {}),
  });
  return true;
}
