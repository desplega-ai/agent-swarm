import { canProvisionKind } from "../../runtime-providers";
import type { Agent, RuntimePool } from "../../types";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { getRuntimePool } from "./db";

export function isRuntimePoolWakeable(pool: RuntimePool, now = new Date()): boolean {
  if (!pool.enabled || (pool.circuitOpenUntil && Date.parse(pool.circuitOpenUntil) > now.getTime()))
    return false;
  return canProvisionKind(pool.kind);
}

export async function isAgentReachable(agent: Agent): Promise<boolean> {
  if (agent.status !== "offline") return true;
  if (!isRuntimePoolsEnabled() || !agent.runtimePoolId) return false;
  const pool = await getRuntimePool(agent.runtimePoolId);
  return pool !== null && isRuntimePoolWakeable(pool);
}
