import { canProvisionKind } from "../../runtime-providers";
import type { Agent, RuntimePool } from "../../types";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { getDbClient } from "../db";
import { getRuntimePool } from "./db";

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
