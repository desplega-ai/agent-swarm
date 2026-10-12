import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getSwarmConfigs } from "../be/db";
import { getLocalFleetStats } from "../be/fleet-benchmark-stats";
import {
  compareWithFleet,
  FLEET_MIN_FINISHED_TASKS,
  type FleetBenchmarks,
  fleetBucketFor,
  type LocalFleetStats,
  localSuccessRate,
  localTasksPerWeek,
} from "../fleet-benchmark";
import { isTelemetryEnabled } from "../telemetry";
import { rejectGuest } from "./request-principal";
import { route } from "./route-def";
import { telemetryProxyEndpoint } from "./used-by";

/** The fleet changes slowly; one proxy call a day per install is plenty. */
const FLEET_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed call, wait before asking the proxy again. */
const FLEET_FAILURE_TTL_MS = 60 * 60 * 1000;
/** Local counts scan agent_tasks; the card does not need them fresher. */
const LOCAL_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10_000;

const FleetStateSchema = z.enum([
  "ready",
  "telemetry_off",
  "no_org_name",
  "not_enough_tasks",
  "unavailable",
]);

const FleetBenchmarkResponseSchema = z.object({
  state: FleetStateSchema,
  local: z
    .object({
      tasksPerWeek: z.number(),
      taskSuccessRate: z.number().nullable(),
      finishedTasks: z.number().int(),
      agents: z.number().int(),
      bucket: z.enum(["1", "2-5", "6+"]).nullable(),
    })
    .nullable(),
  minFinishedTasks: z.number().int(),
  generatedAt: z.string().nullable(),
  comparisons: z.array(
    z.object({
      key: z.enum(["tasksPerWeek", "taskSuccessRate"]),
      value: z.number(),
      p50: z.number(),
      band: z.enum(["top_10", "top_25", "above_median", "below_median", "bottom_25"]),
      peers: z.enum(["1", "2-5", "6+", "all"]),
      installs: z.number().int(),
    }),
  ),
});

export type FleetBenchmarkResponse = z.infer<typeof FleetBenchmarkResponseSchema>;

// ─── Route Definitions ───────────────────────────────────────────────────────

const fleetBenchmark = route({
  method: "get",
  path: "/api/fleet-benchmark",
  pattern: ["api", "fleet-benchmark"],
  summary: "Compare this swarm with similar swarms",
  description:
    "Places this swarm's tasks per week and task success rate (last 30 days) in the fleet percentiles published by the telemetry proxy, against swarms with the same agent count when enough exist. Needs telemetry on and an organization name; otherwise `state` says what is missing and the proxy is not called. The fleet numbers are cached for a day.",
  tags: ["Telemetry"],
  responses: {
    200: {
      description: "Benchmark, or the reason it is not shown",
      schema: FleetBenchmarkResponseSchema,
    },
    401: { description: "Unauthorized" },
    403: { description: "Guest page sessions cannot read the benchmark" },
  },
});

// ─── Caches ──────────────────────────────────────────────────────────────────

let fleetCache: { value: FleetBenchmarks | null; until: number } | null = null;
let localCache: { value: LocalFleetStats; until: number } | null = null;

export function _resetFleetBenchmarkCacheForTests(): void {
  fleetCache = null;
  localCache = null;
}

function isFleetBenchmarks(value: unknown): value is FleetBenchmarks {
  const body = value as Partial<FleetBenchmarks> | null;
  return (
    typeof body === "object" &&
    body !== null &&
    typeof body.generatedAt === "string" &&
    typeof body.overall === "object" &&
    body.overall !== null &&
    typeof body.byAgentCount === "object"
  );
}

/** The proxy's fleet percentiles. The request carries no install ID. */
async function fleetBenchmarks(now: number): Promise<FleetBenchmarks | null> {
  if (fleetCache && fleetCache.until > now) return fleetCache.value;
  let value: FleetBenchmarks | null = null;
  try {
    const response = await fetch(
      `${await telemetryProxyEndpoint("/v1/fleet/benchmarks")}?window=30d`,
      {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (response.ok) {
      const body: unknown = await response.json();
      if (isFleetBenchmarks(body)) value = body;
    }
  } catch {
    // Unreachable proxy: the card says the comparison is unavailable.
  }
  fleetCache = { value, until: now + (value ? FLEET_TTL_MS : FLEET_FAILURE_TTL_MS) };
  return value;
}

async function localStats(now: Date): Promise<LocalFleetStats> {
  if (localCache && localCache.until > now.getTime()) return localCache.value;
  const value = await getLocalFleetStats(now);
  localCache = { value, until: now.getTime() + LOCAL_TTL_MS };
  return value;
}

async function orgName(): Promise<string | undefined> {
  const stored = (
    await getSwarmConfigs({ scope: "global", key: "SWARM_ORG_NAME" })
  )?.[0]?.value?.trim();
  return stored || process.env.SWARM_ORG_NAME?.trim() || undefined;
}

export async function buildFleetBenchmarkResponse(
  now = new Date(),
): Promise<FleetBenchmarkResponse> {
  const empty = {
    local: null,
    minFinishedTasks: FLEET_MIN_FINISHED_TASKS,
    generatedAt: null,
    comparisons: [],
  };
  // Telemetry off means no call to our proxy at all, not even an anonymous one.
  if (!isTelemetryEnabled()) return { state: "telemetry_off", ...empty };
  if (!(await orgName())) return { state: "no_org_name", ...empty };

  const stats = await localStats(now);
  const finishedTasks = stats.tasksCompleted + stats.tasksFailed;
  const local = {
    tasksPerWeek: localTasksPerWeek(stats, now),
    taskSuccessRate: localSuccessRate(stats),
    finishedTasks,
    agents: stats.agents,
    bucket: fleetBucketFor(stats.agents),
  };
  if (finishedTasks < FLEET_MIN_FINISHED_TASKS)
    return { ...empty, state: "not_enough_tasks", local };

  const fleet = await fleetBenchmarks(now.getTime());
  const comparisons = fleet ? compareWithFleet(stats, fleet, now) : [];
  if (!fleet || comparisons.length === 0) return { ...empty, state: "unavailable", local };
  return {
    state: "ready",
    local,
    minFinishedTasks: FLEET_MIN_FINISHED_TASKS,
    generatedAt: fleet.generatedAt,
    comparisons,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleFleetBenchmark(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!fleetBenchmark.match(req.method, pathSegments)) return false;
  if (rejectGuest(req, res)) return true;
  const parsed = await fleetBenchmark.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  fleetBenchmark.respond(res, 200, await buildFleetBenchmarkResponse());
  return true;
}
