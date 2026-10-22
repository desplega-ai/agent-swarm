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
