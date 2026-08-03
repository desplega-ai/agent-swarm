import { mcpOverflowAuthError } from "@/kv-overflow";

/**
 * Ordinary KV namespaces intentionally remain readable across agents. MCP
 * overflow is different: it contains tool-result business data and is private
 * to the authenticated agent whose finalizer created the spill.
 */
export function kvReadAuthError(
  namespace: string,
  info: { agentId: string | undefined },
): string | null {
  return mcpOverflowAuthError(namespace, info.agentId);
}
