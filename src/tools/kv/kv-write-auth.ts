import { getAgentById } from "@/be/db";
import { can } from "@/rbac";

/**
 * Shared write-authorization guard for the kv-set / kv-delete / kv-incr MCP
 * tools (previously duplicated in each file). Returns the denial message when
 * the write is not allowed, null otherwise.
 *
 * The `task:page:*` branch is a request-shape structural guard — MCP requests
 * don't carry an X-Page-Id, page writes must go through the browser SDK +
 * page proxy. It is NOT a principal permission, so it stays inline here and
 * does not go through can() (plan Phase 3 scope boundary).
 */
export function kvWriteAuthError(
  namespace: string,
  info: { agentId: string | undefined },
): string | null {
  if (namespace.startsWith("task:page:")) {
    return "task:page:* writes require a page-proxy request, not an MCP call";
  }
  if (namespace.startsWith("task:agent:")) {
    // A missing caller identity can never own a namespace nor be lead — same
    // denial as before (no separate "agent not found" branch). Own-namespace
    // writes skip the lead lookup, as before.
    const ownNamespace = info.agentId != null && namespace === `task:agent:${info.agentId}`;
    const agent = !ownNamespace && info.agentId ? getAgentById(info.agentId) : null;
    const allowed =
      info.agentId != null &&
      can({
        principal: { kind: "agent", agentId: info.agentId, isLead: agent?.isLead ?? false },
        verb: "kv.write.any",
        resource: { kind: "kv-namespace", namespace },
        source: "mcp",
      }).allow;
    if (!allowed) {
      return "writes to another agent's namespace require lead";
    }
  }
  return null;
}
