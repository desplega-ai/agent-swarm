import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getSwarmConfigs, getWorkflow } from "../be/db";
import type { DbParam } from "../be/db-client";
import type { SavingsSql } from "../be/savings/compute";
import {
  type Calibration,
  type CurveSet,
  type PricedWorkflow,
  parseCalibration,
  SAVINGS_CALIBRATION_KEY,
  SAVINGS_TIERS,
  type SavingsBand,
  SHIPPED_CALIBRATION,
  savingsAssumptions,
} from "../be/savings/model";
import {
  type FleetKindTotals,
  isKnownScriptName,
  readFleetLlmUsd,
  readFleetSavings,
  readScheduleSavings,
  readScriptSavings,
  readWorkflowComponents,
  readWorkflowSavings,
  type SavingsComponent,
  type SavingsTotals,
  type ScheduleSavingsRow,
  savingsWindow,
  type WorkflowComponentsRead,
  type WorkflowSavingsRead,
  type WorkflowSavingsRow,
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
function budgetedSql(budgetMs: () => number): SavingsSql {
  return async <T>(sql: string, params: DbParam[]) => {
    const result = await executeReadOnlyQueryGated(sql, params, budgetMs(), 10_000);
    return result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column, i) => [column, row[i]])),
    ) as T[];
  };
}

/** One scan at the HTTP db-query budget, without waiting out a full cap (the calibration run). */
export const boundedSql = budgetedSql(getDbQueryHttpBudgetMs);

/** Retries a scan refused by a full concurrency cap, `attempts` times in all, sleeping `stepMs` x attempt (at most 5 s) between them. */
function waitOutCap(run: SavingsSql, attempts: number, stepMs: number): SavingsSql {
  return async <T>(sql: string, params: DbParam[]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run<T>(sql, params);
      } catch (err) {
        if (!(err instanceof DbQueryConcurrencyCapError) || attempt >= attempts) throw err;
        await Bun.sleep(Math.min(5_000, stepMs * attempt));
      }
    }
  };
}

/**
 * Request-path scans (today's bucket of one workflow, the window's first day)
 * use the HTTP db-query budget. A full cap is waited out for about 2 s, so
 * parallel reads queue instead of falling back to an estimate.
 */
export const savingsRequestSql = waitOutCap(budgetedSql(getDbQueryHttpBudgetMs), 8, 75);

/** The router's step scan for one day takes about 10 s. */
const ROLLUP_QUERY_BUDGET_MS = 60_000;

/**
 * Scans of the hourly rollup. They run in the background, so a full
 * concurrency cap is waited out (up to about a minute) instead of failing the day.
 */
export const savingsRollupSql = waitOutCap(
  budgetedSql(() => ROLLUP_QUERY_BUDGET_MS),
  20,
  250,
);

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
  /** Set on a schedule's row (`scheduleId` or `kind=schedule`): the schedule whose target this row prices. */
  scheduleId: z.string().optional(),
  scheduleName: z.string().optional(),
  scheduleEnabled: z.boolean().optional(),
  /** `target-job` on a schedule's row: runs carry no schedule link, so this is the target's whole row, shared with any other schedule of it. */
  scope: z.literal("target-job").optional(),
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

/** What an agent-task schedule's tasks cost. There is no automation to substitute, so no saving. */
const SavingsMeasuredRowSchema = z.object({
  kind: z.literal("agent-task-schedule"),
  scheduleId: z.string(),
  scheduleName: z.string(),
  scheduleEnabled: z.boolean(),
  name: z.string(),
  basis: z.literal("measured"),
  runs: z.number().int().describe("Agent tasks the schedule created in the window."),
  actualUsd: z
    .number()
    .describe(
      "Recorded cost of those tasks. A floor: review tasks and follow-ups are not linked to the schedule.",
    ),
  actualHours: z.number(),
  savingUsd: z.null(),
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
  /** `shipped`: the constants in the release. `deployment`: derived from this swarm's own sessions. */
  calibrationSource: z.enum(["shipped", "deployment"]),
  /** Newest rollup time of the window's days; null before the first rollup. */
  computedAt: z.string().nullable(),
  /** False when there is nothing to show: the window is not computed yet, or had no runs. Never $0. */
  valid: z.boolean(),
  /** `target-missing`: `GET /api/savings/jobs?scheduleId=` for a schedule whose workflow or script is gone. */
  reason: z.enum(["not-computed", "no-runs", "target-missing"]).nullable(),
  boundaryEstimated: z
    .boolean()
    .describe(
      "The window is rolling, so its first UTC day is partial and its runs are scanned live. True when that scan could not run (too many runs, or a busy database) and the day's bucket was scaled to the part inside the window instead.",
    ),
};

const SavingsJobsResponseSchema = z.object({
  ...savingsMeta,
  rows: z.array(z.union([SavingsJobRowSchema, SavingsMeasuredRowSchema])),
  /** Sum of `rows`; the band is the single-job spread for one row and the fleet spread for more. Null for schedule reads, where schedules of one target would count it twice. */
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

const FleetKindTotalsSchema = z.object({
  jobs: z.number().int(),
  runs: z.number().int(),
  substitutedRuns: z.number().int(),
  savingUsd: z.number().describe("p50"),
  hoursSaved: z.number().describe("p50"),
});

const SavingsSummaryResponseSchema = z.object({
  ...savingsMeta,
  /** Every workflow and script; the fleet band unless the fleet is one job. */
  total: SavingsTotalsSchema.nullable(),
  byKind: z
    .object({
      workflows: FleetKindTotalsSchema,
      scheduledScripts: FleetKindTotalsSchema,
      agentInvokedScripts: FleetKindTotalsSchema,
    })
    .nullable(),
  fleetLlmUsd: z
    .number()
    .describe("Measured session spend of the whole swarm in the window, as on the usage page."),
  selfOptimizationRatio: z
    .number()
    .nullable()
    .describe(
      "`(fleetLlmUsd + savingUsd.p50) / fleetLlmUsd`: what the swarm would have spent without its automations, per dollar it spent. Null without spend or without a valid total.",
    ),
  excluded: z
    .object({
      enabledOnlyRuns: z
        .number()
        .int()
        .describe(
          "Runs that are not substituted: router events and API runs with no effect, polls above the hourly cap, skipped and cancelled runs.",
        ),
    })
    .nullable(),
  assumptions: z.array(z.string()),
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
    "What the workflows' or scripts' runs in the window would have cost as agent tasks, minus what they cost, read from the hourly savings rollup. With `workflowId` and `components=true`, also returns the workflow's components (child workflow runs, nested script runs and tasks its runs caused, recursively) priced as on their own rows, and `withComponents`, own runs plus those; lists and schedule reads reject `components=true`. `measuredUsd` is the measured spend and `estimatedLlmUsd` the LLM spend estimated where none was recorded; `actualUsd` is their sum scaled to the substituted share of runs, the estimate the saving subtracts. Modelled at the chosen tier, with an 80% range (p10 to p90). Pass `workflowId` for one workflow, `scriptName` for one script, or `kind=workflow` / `kind=script` for every workflow or script with runs. Scheduled scripts are priced as standalone agent tasks; other scripts as the extra turns they add to the calling agent's session. Scripts record no LLM spend, so their spend fields are 0. Pass `scheduleId` for one schedule, or `kind=schedule` for every schedule: a workflow or script target returns the target's row (`scope: target-job`, with `scheduleId`), because runs carry no schedule link, so schedules of one target show the same row, and `total` is null for schedule reads; an agent-task target returns a measured row (`basis` measured) with the recorded cost of its tasks and `savingUsd: null`. A disabled schedule is priced from its target's runs and flagged by `scheduleEnabled`. `valid` is false until the rollup has computed every day of the window, and when there were no runs.",
  tags: ["Savings"],
  query: z.object({
    workflowId: z.string().min(1).optional(),
    scriptName: z.string().min(1).optional(),
    scheduleId: z.string().min(1).optional(),
    kind: z.enum(["workflow", "script", "schedule"]).optional(),
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
        "Not exactly one of workflowId, scriptName, scheduleId and kind, `components=true` without workflowId, or an unknown days or tier value",
    },
    404: { description: "Workflow, script or schedule not found" },
  },
});

const savingsDailyRoute = route({
  method: "get",
  path: "/api/savings/daily",
  pattern: ["api", "savings", "daily"],
  summary: "Daily automation savings of a workflow, a script or the fleet",
  description:
    "The p50 saving, measured spend, estimated LLM spend and scaled actual cost per UTC day of the window, from the hourly savings rollup. With `workflowId` or `scriptName` the points add up to the window figures of `GET /api/savings/jobs` for the same target; with neither they cover every workflow and script and add up to `GET /api/savings/summary`.",
  tags: ["Savings"],
  query: z.object({
    workflowId: z.string().min(1).optional(),
    scriptName: z.string().min(1).optional(),
    ...windowQuery,
  }),
  responses: {
    200: { description: "Daily savings points", schema: SavingsDailyResponseSchema },
    400: {
      description: "Both workflowId and scriptName, or an unknown days or tier value",
    },
    404: { description: "Workflow or script not found" },
  },
});

const savingsSummaryRoute = route({
  method: "get",
  path: "/api/savings/summary",
  pattern: ["api", "savings", "summary"],
  summary: "Fleet automation savings",
  description:
    "What every workflow and script run in the window would have cost as agent tasks, minus what they cost, from the hourly savings rollup at the chosen tier, with the fleet's 80% range. Adds the swarm's measured session spend over the same window, the self-optimization ratio, the runs left out and the model's assumptions. `valid` is false until the rollup has computed every day of the window, and when there were no runs.",
  tags: ["Savings"],
  query: z.object(windowQuery),
  responses: {
    200: { description: "Fleet savings", schema: SavingsSummaryResponseSchema },
    400: { description: "An unknown days or tier value" },
  },
});

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

/** Forget the cached curve, so the next savings request reads the stored row. */
export function clearCalibrationCache(): void {
  calibrationCache = null;
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

function toScheduleRow(row: ScheduleSavingsRow) {
  const ref = {
    scheduleId: row.scheduleId,
    scheduleName: row.scheduleName,
    scheduleEnabled: row.scheduleEnabled,
  };
  if (row.basis === "measured") {
    return {
      ...ref,
      kind: row.kind,
      name: row.name,
      basis: row.basis,
      runs: row.runs,
      actualUsd: round2(row.actualUsd),
      actualHours: round2(row.actualHours),
      savingUsd: null,
    };
  }
  return { ...toRow(row), ...ref, scope: "target-job" as const };
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

function roundKind(k: FleetKindTotals): FleetKindTotals {
  return { ...k, savingUsd: round2(k.savingUsd), hoursSaved: round2(k.hoursSaved) };
}

function notFound(
  res: ServerResponse,
  what: "Workflow" | "Script" | "Schedule" = "Workflow",
): true {
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
async function readScript(
  scriptName: string,
  days: number,
  tier: (typeof SAVINGS_TIERS)[number],
  curve: CurveSet,
) {
  if (!(await isKnownScriptName(scriptName))) return null;
  return readScriptSavings({
    days,
    tier,
    now: Date.now(),
    scriptName,
    sql: savingsRequestSql,
    curve,
  });
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

/** Test hook: forget the refresh state and the held component trees. */
export function resetSavingsRefreshCache(): void {
  inFlight.clear();
  scannedAt.clear();
  heldTrees.clear();
}

/**
 * Component trees per workflow, window and tier, keyed also by the own row's
 * rollup time, so a refreshed own row gets a fresh tree. Concurrent reads share
 * the read in flight, and a tree is reused for REFRESH_TTL_MS: the tree reads
 * the fleet's rollup rows, so a burst reads them once a minute at most.
 */
const heldTrees = new Map<string, { at: number; tree: Promise<WorkflowComponentsRead> }>();
const MAX_HELD_TREES = 200;

function componentsOf(
  own: WorkflowSavingsRow,
  days: number,
  tier: (typeof SAVINGS_TIERS)[number],
  computedAt: string | null,
  calibration: Calibration,
): Promise<WorkflowComponentsRead> {
  const now = Date.now();
  for (const [k, h] of heldTrees) if (now - h.at >= REFRESH_TTL_MS) heldTrees.delete(k);
  const key = [
    own.workflowId,
    days,
    tier,
    computedAt ?? "",
    calibration.source,
    calibration.calibratedAt,
    calibration.model,
  ].join("\u0000");
  const held = heldTrees.get(key);
  if (held) return held.tree;
  const tree = readWorkflowComponents({
    days,
    tier,
    now,
    workflowId: own.workflowId,
    own,
    curve: calibration.curve,
  });
  // A failed read is not held: the next request reads again.
  tree.catch(() => {
    // Only this read's own entry: an expired one may already be replaced.
    if (heldTrees.get(key)?.tree === tree) heldTrees.delete(key);
  });
  if (heldTrees.size >= MAX_HELD_TREES) {
    const oldest = heldTrees.keys().next().value;
    if (oldest !== undefined) heldTrees.delete(oldest);
  }
  heldTrees.set(key, { at: now, tree });
  return tree;
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
  const done = refreshWorkflowToday(workflow, savingsRequestSql, now)
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
async function readOne(
  workflowId: string,
  days: number,
  tier: (typeof SAVINGS_TIERS)[number],
  curve: CurveSet,
) {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) return null;
  const now = Date.now();
  await refreshToday(workflow, now);
  return readWorkflowSavings({ days, tier, now, workflowId, sql: savingsRequestSql, curve });
}

function meta(
  read: {
    window: { start: string; end: string; days: number };
    computedAt: string | null;
    boundaryEstimated: boolean;
  },
  tier: (typeof SAVINGS_TIERS)[number],
  calibration: Calibration,
  valid: { complete: boolean; hasRows: boolean; targetMissing?: boolean },
) {
  return {
    window: read.window,
    tier,
    calibrationModel: calibration.model,
    calibratedAt: calibration.calibratedAt,
    calibrationSource: calibration.source,
    computedAt: read.computedAt,
    valid: valid.complete && valid.hasRows,
    reason: !valid.complete
      ? ("not-computed" as const)
      : valid.hasRows
        ? null
        : valid.targetMissing
          ? ("target-missing" as const)
          : ("no-runs" as const),
    boundaryEstimated: read.boundaryEstimated,
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
    if (workflowId && scriptName) return badTarget(res, "Pass workflowId or scriptName, not both");
    const calibration = await activeCalibration(Date.now());
    const read = workflowId
      ? await readOne(workflowId, days, tier, calibration.curve)
      : scriptName
        ? await readScript(scriptName, days, tier, calibration.curve)
        : await readFleetSavings({
            days,
            tier,
            now: Date.now(),
            sql: savingsRequestSql,
            curve: calibration.curve,
          });
    if (!read) return notFound(res, workflowId ? "Workflow" : "Script");
    const hasRows = read.total !== null;
    const points = read.complete && hasRows ? read.points : [];
    const saving = roundToTotal(points.map((p) => p.savingUsd));
    const actual = roundToTotal(points.map((p) => p.actualUsd));
    const measured = roundToTotal(points.map((p) => p.measuredUsd));
    const estimated = roundToTotal(points.map((p) => p.estimatedLlmUsd));
    savingsDailyRoute.respond(res, 200, {
      ...meta(read, tier, calibration, { complete: read.complete, hasRows }),
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

  if (savingsSummaryRoute.match(req.method, pathSegments)) {
    const parsed = await savingsSummaryRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { days, tier } = parsed.query;
    const now = Date.now();
    // The spend sum needs only the window: it waits for the connection alongside the fleet read.
    const llm = readFleetLlmUsd(savingsWindow(days, now));
    // Settled here so a fleet read that throws leaves no unhandled rejection behind.
    llm.catch(() => {});
    const calibration = await activeCalibration(now);
    const read = await readFleetSavings({
      days,
      tier,
      now,
      sql: savingsRequestSql,
      curve: calibration.curve,
    });
    const fleetLlmUsd = await llm;
    const total = read.complete ? read.total : null;
    savingsSummaryRoute.respond(res, 200, {
      ...meta(read, tier, calibration, { complete: read.complete, hasRows: read.total !== null }),
      total: total ? toTotals(total) : null,
      byKind: total
        ? {
            workflows: roundKind(read.byKind.workflows),
            scheduledScripts: roundKind(read.byKind.scheduledScripts),
            agentInvokedScripts: roundKind(read.byKind.agentInvokedScripts),
          }
        : null,
      fleetLlmUsd: round2(fleetLlmUsd),
      selfOptimizationRatio:
        total && fleetLlmUsd > 0 ? (fleetLlmUsd + total.savingUsd.p50) / fleetLlmUsd : null,
      excluded: total ? { enabledOnlyRuns: total.enabledOnlyRuns } : null,
      assumptions: savingsAssumptions(tier),
    });
    return true;
  }

  if (!savingsJobsRoute.match(req.method, pathSegments)) return false;
  const parsed = await savingsJobsRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const { workflowId, scriptName, scheduleId, kind, days, tier, components } = parsed.query;
  if ([workflowId, scriptName, scheduleId, kind].filter(Boolean).length !== 1) {
    return badTarget(
      res,
      "Pass one of workflowId, scriptName, scheduleId, kind=workflow, kind=script or kind=schedule",
    );
  }
  if (components && !workflowId) {
    return badTarget(res, "components=true needs workflowId; lists count own runs only");
  }
  const calibration = await activeCalibration(Date.now());
  const now = Date.now();
  if (scheduleId || kind === "schedule") {
    const read = await readScheduleSavings({
      days,
      tier,
      now,
      scheduleId,
      sql: savingsRequestSql,
      curve: calibration.curve,
    });
    if (!read) return notFound(res, "Schedule");
    // Measured rows are read live, so they show even while the modelled rollup is incomplete.
    const rows = read.complete ? read.rows : read.rows.filter((r) => r.basis === "measured");
    savingsJobsRoute.respond(res, 200, {
      ...meta(read, tier, calibration, {
        complete: read.complete || rows.length > 0,
        hasRows: rows.length > 0,
        targetMissing: read.targetMissing,
      }),
      rows: rows.map(toScheduleRow),
      total: null,
    });
    return true;
  }
  const read: (Omit<WorkflowSavingsRead, "rows"> & { rows: ReadRow[] }) | null = workflowId
    ? await readOne(workflowId, days, tier, calibration.curve)
    : scriptName
      ? await readScript(scriptName, days, tier, calibration.curve)
      : kind === "script"
        ? await readScriptSavings({
            days,
            tier,
            now,
            sql: savingsRequestSql,
            curve: calibration.curve,
          })
        : await readWorkflowSavings({
            days,
            tier,
            now,
            sql: savingsRequestSql,
            curve: calibration.curve,
          });
  if (!read) return notFound(res, scriptName ? "Script" : "Workflow");
  const show = read.complete;
  const own = show && workflowId ? read.rows[0] : undefined;
  const tree =
    components && own && "workflowId" in own
      ? await componentsOf(own, days, tier, read.computedAt, calibration)
      : null;
  savingsJobsRoute.respond(res, 200, {
    ...meta(read, tier, calibration, { complete: read.complete, hasRows: read.rows.length > 0 }),
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
