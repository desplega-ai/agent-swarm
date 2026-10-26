import type { WorkflowNode } from "../types";

/** Watchdog budget for a node that configures none. */
export const DEFAULT_NODE_TIMEOUT_MS = 30_000;

/**
 * The workflow watchdog budget for one executor call of `node`.
 *
 * Inline script nodes historically expose their wall-clock budget as
 * `config.timeout`, while the workflow watchdog reads `config.timeoutMs` for
 * every other executor. Keep the outer watchdog aligned with the script
 * executor so a script configured for (for example) 90s is not killed by the
 * 30s default first. The foreach driver applies this to each child with the
 * synthesized body node, so every item gets its own budget.
 */
export function resolveNodeTimeoutMs(node: Pick<WorkflowNode, "type" | "config">): number {
  const config = node.config ?? {};
  if (typeof config.timeoutMs === "number") return config.timeoutMs;
  if (node.type === "script" && typeof config.timeout === "number") return config.timeout;
  return DEFAULT_NODE_TIMEOUT_MS;
}

export interface StepDeadline {
  /** Aborted when the budget runs out. The executor gets it as `meta.signal`. */
  signal: AbortSignal;
  /** Rejects with "Step timed out after <ms>ms" when the budget runs out. */
  expired: Promise<never>;
  /** Stop the timer once the executor call settled. */
  clear: () => void;
}

/**
 * The watchdog for one executor call. Racing `expired` alone settles the step
 * but leaves the executor running, so a step reported as timed out could still
 * perform its side effects. On expiry the deadline also aborts `signal`, so an
 * executor that forwards it (swarm-script kills its script process) stops.
 */
export function startStepDeadline(timeoutMs: number): StepDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Step timed out after ${timeoutMs}ms`);
      // Reject first so the race settles on the timeout, not on the
      // executor's "killed" result that the abort produces.
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  return { signal: controller.signal, expired, clear: () => clearTimeout(timer) };
}
