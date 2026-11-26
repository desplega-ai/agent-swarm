import { getAgentById } from "@/be/db";
import { mcpOverflowAuthError } from "@/kv-overflow";
import { privateNamespaceError } from "@/kv-reserved-namespaces";

/**
 * Ordinary KV namespaces intentionally remain readable across agents. MCP
 * overflow is different: it contains tool-result business data and is private
 * to the authenticated agent whose finalizer created the spill. Private
 * reserved families (`session-labels`) are not readable here at all, and
 * `slack-feedback` only by a Lead agent.
 */
export async function kvReadAuthError(
  namespace: string,
  info: { agentId: string | undefined },
): Promise<string | null> {
  const agent = info.agentId ? await getAgentById(info.agentId) : null;
  return (
    privateNamespaceError(namespace, { isLead: agent?.isLead === true }) ??
    mcpOverflowAuthError(namespace, info.agentId)
  );
}
