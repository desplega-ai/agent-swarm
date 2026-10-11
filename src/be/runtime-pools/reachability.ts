import { createRuntimeProvider } from "../../runtime-providers";
import type { Agent, RuntimePool } from "../../types";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { getRuntimePool } from "./db";

export async function isRuntimePoolWakeable(pool: RuntimePool, now = new Date()): Promise<boolean> {
  if (!pool.enabled || (pool.circuitOpenUntil && Date.parse(pool.circuitOpenUntil) > now.getTime()))
    return false;
  // The schema reserves this kind, but no adapter implements it yet.
  if (pool.kind === "k8s") return false;
  return (await createRuntimeProvider(pool.kind)).traits.canProvision;
}

export async function isAgentReachable(agent: Agent): Promise<boolean> {
  if (agent.status !== "offline") return true;
  if (!isRuntimePoolsEnabled() || !agent.runtimePoolId) return false;
  const pool = await getRuntimePool(agent.runtimePoolId);
  return pool !== null && (await isRuntimePoolWakeable(pool));
}
