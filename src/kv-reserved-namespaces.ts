/**
 * Namespace families owned by internal subsystems which write through the raw
 * DB helpers. Generic HTTP/MCP KV callers may read these namespaces for
 * inspection, but must not mutate them. A family is `<name>` and `<name>:*`,
 * mapped here to the error a generic write gets.
 */
const RESERVED_FAMILIES = new Map([
  ["apps", "namespace is reserved for swarm apps; use the app row endpoints"],
  // step-9: Comb's "Send to swarm" claims (`comb:sent`).
  ["comb", "namespace is reserved for Comb; use POST /api/comb/review-batches"],
]);

export function isReservedNamespace(namespace: string): boolean {
  return reservedNamespaceError(namespace) !== null;
}

export function reservedNamespaceError(namespace: string): string | null {
  return RESERVED_FAMILIES.get(namespace.split(":", 1)[0] ?? "") ?? null;
}

export function reservedRoomKeyError(key: string): string | null {
  return key.startsWith("_room/")
    ? "room snapshot keys are reserved; use the room endpoints"
    : null;
}
