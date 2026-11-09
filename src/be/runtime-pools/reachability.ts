import { canProvisionKind } from "../../runtime-providers";
import type { Agent, RuntimePool } from "../../types";
import { isMultiRuntimeEnabled } from "../../utils/multi-runtime";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { getDbClient } from "../db";
import { listRuntimeInstancesForPool, runtimeStaleThresholdMinutes } from "../multi-runtime";
import { getRuntimePool } from "./db";
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
  return (
    (await getDbClient().get(
      `SELECT id FROM runtime_instances WHERE agent_id = ? AND pool_id = ?
     AND status = 'provisioning' AND draining = 0 LIMIT 1`,
      [agent.id, pool.id],
    )) !== null
  );
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
  if (agent.status !== "offline" || !agent.runtimePoolId) return false;
  if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return false;
  const pool = await getRuntimePool(agent.runtimePoolId);
  if (!pool?.enabled) return false;
  const runtimes = await listRuntimeInstancesForPool(pool.id);
  const own = runtimes.filter((r) => r.agentId === agent.id);
  if (own.some((r) => r.status === "provisioning" && !r.draining)) return true;
  if (!isRuntimePoolWakeable(pool, now)) return false;
  const staleMinutes = runtimeStaleThresholdMinutes();
  const limit = agentRuntimeLimit(agent.maxTasks ?? 1, pool.slotsPerRuntime);
  if (countPoolRuntimes(own, now, staleMinutes) >= limit) return false;
  if (pool.maxRuntimes === null) return true;
  return countPoolRuntimes(runtimes, now, staleMinutes) < pool.maxRuntimes;
}
