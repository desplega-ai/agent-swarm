import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
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
import { COMPANY_TEAM_SIZES, COMPANY_USE_CASES, reportedUseCase } from "../utils/company-profile";
import { normalizeOrgWebsite } from "../utils/org-website";
import { globalConfig } from "./global-config";
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
  level: z.enum(["basic", "full"]),
  peerGroup: z
    .object({
      teamSize: z.string().nullable(),
      useCase: z.string().nullable(),
      orgs: z.number().int(),
    })
    .nullable(),
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
    "Compares local task volume and success rate with fleet percentiles over the last 30 days. Comparisons require telemetry, an organization name, and a known proxy ingest date. A website, team size, and use case enable full comparisons with peer filters. The response includes the proxy's peer group when available. With telemetry off, it returns local DB counts without a proxy request. The fleet cache key includes the peer filters.",
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

let fleetCache: { key: string; value: ProxyFleetBenchmarks | null; until: number } | null = null;
let localCache: {
  requireIngestAnchor: boolean;
  value: LocalFleetStats | null;
  until: number;
} | null = null;

const ProxyMetricSchema = z.object({
  n: z.number(),
  p25: z.number().optional(),
  p50: z.number().optional(),
  p75: z.number().optional(),
  p90: z.number().optional(),
  omitted: z.string().optional(),
});
const ProxyBlockSchema = z.object({
  installs: z.number(),
  tasksPerWeek: ProxyMetricSchema,
  taskSuccessRate: ProxyMetricSchema,
});
/**
 * Everything `compareWithFleet` reads from `GET /v1/fleet/benchmarks`. A body
 * that fails it counts as a failed call, so a malformed 200 is never cached.
 */
const ProxyFleetBenchmarksSchema = z.object({
  window: z.string(),
  generatedAt: z.string(),
  minInstallsPerBucket: z.number(),
  minFinishedTasks: z.number(),
  overall: ProxyBlockSchema,
  byAgentCount: z.object({
    "1": ProxyBlockSchema.optional(),
    "2-5": ProxyBlockSchema.optional(),
    "6+": ProxyBlockSchema.optional(),
  }),
  peer_group: z
    .object({
      team_size: z.string().nullable(),
      use_case: z.string().nullable(),
      orgs: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
}) satisfies z.ZodType<FleetBenchmarks>;

type ProxyFleetBenchmarks = z.infer<typeof ProxyFleetBenchmarksSchema>;

/** The proxy's fleet percentiles. The request carries no install ID. */
async function fleetBenchmarks(
  now: number,
  peerGroup: { teamSize: string; useCase: string } | null,
): Promise<ProxyFleetBenchmarks | null> {
  const endpoint = new URL(await telemetryProxyEndpoint("/v1/fleet/benchmarks"));
  endpoint.searchParams.set("window", "30d");
  if (peerGroup) {
    endpoint.searchParams.set("team_size", peerGroup.teamSize);
    endpoint.searchParams.set("use_case", peerGroup.useCase);
  }
  const key = endpoint.toString();
  if (fleetCache?.key === key && fleetCache.until > now) return fleetCache.value;
  let value: ProxyFleetBenchmarks | null = null;
  try {
    const response = await fetch(key, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.ok) {
      const parsed = ProxyFleetBenchmarksSchema.safeParse(await response.json());
      if (parsed.success) value = parsed.data;
    }
  } catch {
    // Unreachable proxy: the card says the comparison is unavailable.
  }
  fleetCache = { key, value, until: now + (value ? FLEET_TTL_MS : FLEET_FAILURE_TTL_MS) };
  return value;
}

async function localStats(now: Date, requireIngestAnchor = true): Promise<LocalFleetStats | null> {
  if (localCache?.requireIngestAnchor === requireIngestAnchor && localCache.until > now.getTime())
    return localCache.value;
  const value = await getLocalFleetStats(now, { requireIngestAnchor });
  localCache = { requireIngestAnchor, value, until: now.getTime() + LOCAL_TTL_MS };
  return value;
}

export async function buildFleetBenchmarkResponse(
  now = new Date(),
): Promise<FleetBenchmarkResponse> {
  const [name, website, teamSize, useCase] = await Promise.all([
    globalConfig("SWARM_ORG_NAME"),
    globalConfig("SWARM_ORG_WEBSITE"),
    globalConfig("SWARM_ORG_TEAM_SIZE"),
    globalConfig("SWARM_ORG_USE_CASE"),
  ]);
  const team = z.enum(COMPANY_TEAM_SIZES).safeParse(teamSize);
  const use = z.enum(COMPANY_USE_CASES).safeParse(useCase);
  const peerGroup =
    normalizeOrgWebsite(website) && team.success && use.success
      ? { teamSize: team.data, useCase: use.data }
      : null;
  // The proxy answers 400 for a use case its catalog does not list yet, so
  // that use case compares against the whole fleet.
  const proxyPeerGroup = peerGroup && reportedUseCase(peerGroup.useCase) ? peerGroup : null;
  const empty = {
    level: peerGroup ? ("full" as const) : ("basic" as const),
    peerGroup: null,
    local: null,
    minFinishedTasks: FLEET_MIN_FINISHED_TASKS,
    generatedAt: null,
    comparisons: [],
  };
  // Telemetry off means no call to our proxy at all, not even an anonymous one.
  const telemetryEnabled = isTelemetryEnabled();
  if (telemetryEnabled && !name) return { state: "no_org_name", ...empty };

  const stats = await localStats(now, telemetryEnabled);
  // Where the proxy started counting this install is unknown: no comparison.
  if (!stats) return { state: "unavailable", ...empty };
  const finishedTasks = stats.tasksCompleted + stats.tasksFailed;
  const local = {
    tasksPerWeek: localTasksPerWeek(stats, now),
    taskSuccessRate: localSuccessRate(stats),
    finishedTasks,
    agents: stats.agents,
    bucket: fleetBucketFor(stats.agents),
  };
  if (!telemetryEnabled) return { ...empty, state: "telemetry_off", local };
  if (finishedTasks < FLEET_MIN_FINISHED_TASKS)
    return { ...empty, state: "not_enough_tasks", local };

  const fleet = await fleetBenchmarks(now.getTime(), proxyPeerGroup);
  const responsePeerGroup =
    peerGroup && fleet?.peer_group
      ? {
          teamSize: fleet.peer_group.team_size,
          useCase: fleet.peer_group.use_case,
          orgs: fleet.peer_group.orgs,
        }
      : null;
  const comparisons = fleet ? compareWithFleet(stats, fleet, now) : [];
  if (!fleet || comparisons.length === 0)
    return { ...empty, state: "unavailable", local, peerGroup: responsePeerGroup };
  return {
    ...empty,
    state: "ready",
    peerGroup: responsePeerGroup,
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
