import { canProvisionKind } from "../../runtime-providers";
import type { Agent, RuntimeInstance, RuntimePool } from "../../types";
import { isMultiRuntimeEnabled } from "../../utils/multi-runtime";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import {
  listRuntimeInstancesForPool,
  listRuntimeInstancesForPools,
  runtimeStaleThresholdMinutes,
} from "../multi-runtime";
import { getStorage } from "../storage";
import { getRuntimePool, listRuntimePools } from "./db";
import { agentRuntimeLimit, countPoolRuntimes } from "./demand";

export function isRuntimePoolWakeable(pool: RuntimePool, now = new Date()): boolean {
  if (!pool.enabled || (pool.circuitOpenUntil && Date.parse(pool.circuitOpenUntil) > now.getTime()))
    return false;
  return (
    canProvisionKind(pool.kind) &&
    pool.maxRuntimes !== 0 &&
    Boolean(pool.resolvedImage ?? pool.image)
  );
}

export async function isAgentReachable(agent: Agent): Promise<boolean> {
  if (agent.status !== "offline") return true;
  if (!isRuntimePoolsEnabled() || !agent.runtimePoolId) return false;
  const pool = await getRuntimePool(agent.runtimePoolId);
  if (!pool?.enabled) return false;
  if (isRuntimePoolWakeable(pool)) return true;
  return await getStorage().repos.runtimePools.hasProvisioningRuntime(agent.id, pool.id);
}

/**
 * True when a task sent now to an offline pool agent gets served by a runtime
 * for it. Stricter than `isAgentReachable`, which also drives heartbeat and
 * chat routing: this one also requires the supervisor to be running
 * (MULTI_RUNTIME_ENABLED). Mirrors the supervisor's `computeDesired` math:
 * 1. A `provisioning`, non-draining runtime for the agent: true. It is booting
 *    and will claim the task (same rule as `isAgentReachable`), even when that
 *    runtime fills a capped pool.
 * 2. Else the agent's own live runtimes at or above
 *    `agentRuntimeLimit(maxTasks, slotsPerRuntime)`: false, it gets no new one.
 * 3. Else a free slot under the pool's `maxRuntimes`.
 */
export async function isAgentOnDemand(agent: Agent, now = new Date()): Promise<boolean> {
  if (!isOnDemandCandidate(agent)) return false;
  const pool = await getRuntimePool(agent.runtimePoolId!);
  if (!pool?.enabled) return false;
  return onDemandIn(agent, pool, await listRuntimeInstancesForPool(pool.id), now);
}

/**
 * The ids of the agents `isAgentOnDemand` flags, read with one pool list and
 * one runtime list for every pool instead of two reads per agent.
 */
export async function listOnDemandAgentIds(
  agents: readonly Agent[],
  now = new Date(),
): Promise<Set<string>> {
  const result = new Set<string>();
  const candidates = agents.filter(isOnDemandCandidate);
  if (candidates.length === 0) return result;
  const pools = new Map(
    (await listRuntimePools()).filter((pool) => pool.enabled).map((pool) => [pool.id, pool]),
  );
  const poolIds = [...new Set(candidates.map((a) => a.runtimePoolId!))].filter((id) =>
    pools.has(id),
  );
  const runtimesByPool = new Map<string, RuntimeInstance[]>(poolIds.map((id) => [id, []]));
  for (const runtime of await listRuntimeInstancesForPools(poolIds))
    runtimesByPool.get(runtime.poolId!)?.push(runtime);
  for (const agent of candidates) {
    const pool = pools.get(agent.runtimePoolId!);
    if (pool && onDemandIn(agent, pool, runtimesByPool.get(pool.id)!, now)) result.add(agent.id);
  }
  return result;
}

function isOnDemandCandidate(agent: Agent): boolean {
  return (
    agent.status === "offline" &&
    Boolean(agent.runtimePoolId) &&
    isRuntimePoolsEnabled() &&
    isMultiRuntimeEnabled()
  );
}

/** The `isAgentOnDemand` decision for an enabled pool and all of its runtimes. */
function onDemandIn(
  agent: Agent,
  pool: RuntimePool,
  runtimes: RuntimeInstance[],
  now: Date,
): boolean {
  const own = runtimes.filter((r) => r.agentId === agent.id);
  if (own.some((r) => r.status === "provisioning" && !r.draining)) return true;
  if (!isRuntimePoolWakeable(pool, now)) return false;
  const staleMinutes = runtimeStaleThresholdMinutes();
  const limit = agentRuntimeLimit(agent.maxTasks ?? 1, pool.slotsPerRuntime);
  if (countPoolRuntimes(own, now, staleMinutes) >= limit) return false;
  if (pool.maxRuntimes === null) return true;
  return countPoolRuntimes(runtimes, now, staleMinutes) < pool.maxRuntimes;
}
