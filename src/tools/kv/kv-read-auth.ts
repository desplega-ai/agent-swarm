import { mcpOverflowAuthError } from "@/kv-overflow";
import { privateNamespaceError } from "@/kv-reserved-namespaces";

/**
 * Ordinary KV namespaces intentionally remain readable across agents. MCP
 * overflow is different: it contains tool-result business data and is private
 * to the authenticated agent whose finalizer created the spill. Private
 * reserved families (`session-labels`) are not readable here at all.
 */
export function kvReadAuthError(
  namespace: string,
  info: { agentId: string | undefined },
): string | null {
  return privateNamespaceError(namespace) ?? mcpOverflowAuthError(namespace, info.agentId);
}
