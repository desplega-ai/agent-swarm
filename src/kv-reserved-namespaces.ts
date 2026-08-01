/**
 * Namespace families owned by internal subsystems which write through the raw
 * DB helpers. Generic HTTP/MCP KV callers may read these namespaces for
 * inspection, but must not mutate them.
 */
export function isReservedNamespace(namespace: string): boolean {
  return namespace === "apps" || namespace.startsWith("apps:");
}

export function reservedNamespaceError(namespace: string): string | null {
  return isReservedNamespace(namespace)
    ? "namespace is reserved for swarm apps; use the app row endpoints"
    : null;
}
