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
 * True when an offline pool agent will get a runtime if a task is sent to it.
 * Stricter than `isAgentReachable`, which also drives heartbeat and chat
 * routing: this one also requires the supervisor to be running
 * (MULTI_RUNTIME_ENABLED), a free slot under the pool's `maxRuntimes`, and an
 * agent `maxTasks` large enough for one runtime. Mirrors the supervisor's
 * `computeDesired` math.
 */
export async function isAgentOnDemand(agent: Agent, now = new Date()): Promise<boolean> {
  if (agent.status !== "offline" || !agent.runtimePoolId) return false;
  if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return false;
  const pool = await getRuntimePool(agent.runtimePoolId);
  if (!pool || !isRuntimePoolWakeable(pool, now)) return false;
  if (agentRuntimeLimit(agent.maxTasks ?? 1, pool.slotsPerRuntime) < 1) return false;
  if (pool.maxRuntimes === null) return true;
  const live = countPoolRuntimes(
    await listRuntimeInstancesForPool(pool.id),
    now,
    runtimeStaleThresholdMinutes(),
  );
  return live < pool.maxRuntimes;
}
