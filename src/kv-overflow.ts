export const MCP_OVERFLOW_NAMESPACE = "mcp:overflow";

export function mcpOverflowNamespace(agentId: string): string {
  return `${MCP_OVERFLOW_NAMESPACE}:${agentId}`;
}

export function mcpOverflowAuthError(
  namespace: string,
  agentId: string | undefined,
): string | null {
  if (namespace !== MCP_OVERFLOW_NAMESPACE && !namespace.startsWith(`${MCP_OVERFLOW_NAMESPACE}:`)) {
    return null;
  }

  if (agentId && namespace === mcpOverflowNamespace(agentId)) {
    return null;
  }

  return "access to another agent's MCP overflow namespace is forbidden";
}
