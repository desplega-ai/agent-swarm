import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getWorkflow } from "../be/db";
import { computeWorkflowWindow, type WorkflowWindow } from "../be/savings/compute";
import {
  CALIBRATED_AT,
  CALIBRATION_MODEL,
  priceWorkflow,
  SAVINGS_TIERS,
  type SavingsBand,
} from "../be/savings/model";
import { route } from "./route-def";

/** Live facts are reused for this long, so page views do not rescan the runs. */
const FACTS_TTL_MS = 10 * 60 * 1000;

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
  actualUsd: z.number(),
  agentOnlyUsd: SavingsBandSchema,
  savingUsd: SavingsBandSchema,
  actualHours: z.number(),
  agentOnlyHours: SavingsBandSchema,
  hoursSaved: SavingsBandSchema,
  agentOnlyUsdPerRun: z.number(),
});

const SavingsJobsResponseSchema = z.object({
  window: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
  tier: z.enum(SAVINGS_TIERS),
  calibrationModel: z.string(),
  calibratedAt: z.string(),
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
    "What the workflow's runs in the window would have cost as agent tasks, minus what they cost. Modelled at the chosen tier, with an 80% range (p10 to p90). `valid` is false when the workflow had no runs, or more runs than the live computation handles.",
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
  },
});

type CachedFacts = { at: number; start: string; end: string; result: Promise<WorkflowWindow> };
const factsCache = new Map<string, CachedFacts>();

/** Test hook. */
export function resetSavingsCache(): void {
  factsCache.clear();
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
    result: computeWorkflowWindow(workflow, { start, end }),
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

export async function handleSavings(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!savingsJobsRoute.match(req.method, pathSegments)) return false;
  const parsed = await savingsJobsRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const { workflowId, days, tier } = parsed.query;
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Workflow not found" }));
    return true;
  }
  const entry = cachedWindow(workflow, days, Date.now());
  const result = await entry.result;
  const base = {
    window: { start: entry.start, end: entry.end, days },
    tier,
    calibrationModel: CALIBRATION_MODEL,
    calibratedAt: CALIBRATED_AT,
    computedAt: new Date(entry.at).toISOString(),
  };
  if (result.status === "too-many-runs" || result.facts.runs === 0) {
    savingsJobsRoute.respond(res, 200, {
      ...base,
      valid: false,
      reason: result.status === "too-many-runs" ? "too-many-runs" : "no-runs",
      rows: [],
    });
    return true;
  }
  const priced = priceWorkflow(result.facts, { tier, days, band: "job" });
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
