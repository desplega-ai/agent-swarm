import type { RequestInfo } from "@swarm/mcp-tool";
import { getTaskById } from "@swarm/storage";
import { agentContextKey } from "@swarm/workflows";

/**
 * Resolve the KV namespace for an MCP tool call.
 *
 * Tools call this when the user didn't pass an explicit `namespace`. The MCP
 * `RequestInfo` exposes `sourceTaskId` (from `X-Source-Task-Id` header) and
 * `agentId` (from `X-Agent-ID`), mirroring the HTTP-layer precedence:
 *
 *   1. explicit `namespace` (handled by the tool, not us)
 *   2. `sourceTaskId` → that task's `contextKey`
 *   3. `agentId` → `task:agent:<id>`
 *   4. nothing — caller is told to pass `namespace`
 *
 * Note: MCP doesn't carry `X-Page-Id` (pages call the REST surface directly
 * via the browser SDK, not MCP), so page-scoped resolution is HTTP-only.
 */
export interface ResolvedNamespace {
  namespace: string;
  source: "explicit" | "task" | "agent";
}

export function resolveNamespace(
  explicit: string | undefined,
  info: RequestInfo,
): ResolvedNamespace | { error: string } {
  if (explicit && explicit.length > 0) {
    return { namespace: explicit, source: "explicit" };
  }

  if (info.sourceTaskId) {
    const task = getTaskById(info.sourceTaskId);
    if (task?.contextKey) {
      return { namespace: task.contextKey, source: "task" };
    }
    if (task?.agentId) {
      try {
        return { namespace: agentContextKey({ agentId: task.agentId }), source: "agent" };
      } catch {
        // fall through
      }
    }
  }

  if (info.agentId) {
    try {
      return { namespace: agentContextKey({ agentId: info.agentId }), source: "agent" };
    } catch {
      // fall through to error
    }
  }

  return {
    error: "namespace could not be resolved — pass `namespace` or run with X-Agent-ID set",
  };
}
