import { MCP_OVERFLOW_NAMESPACE } from "../kv-overflow";
import { sweepExpiredKvPrefix } from "./db";

export const MCP_OVERFLOW_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Delete expired MCP overflow values across every agent's namespace. Runs on
 * a timer, not on the spill path: the DELETE of multi-MB values and its write
 * lock would otherwise land on a read tool's request.
 */
export async function runMcpOverflowSweep(now = Date.now()): Promise<number> {
  try {
    const removed = await sweepExpiredKvPrefix(MCP_OVERFLOW_NAMESPACE, now);
    if (removed > 0) {
      console.debug(`[mcp-overflow] Sweep removed ${removed} expired value(s)`);
    }
    return removed;
  } catch (err) {
    console.error("[mcp-overflow] Sweep failed:", err);
    return 0;
  }
}

export function startMcpOverflowSweep(intervalMs = MCP_OVERFLOW_SWEEP_INTERVAL_MS): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void runMcpOverflowSweep();
  }, intervalMs);
  if (typeof sweepTimer?.unref === "function") sweepTimer.unref();
}

export function stopMcpOverflowSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
