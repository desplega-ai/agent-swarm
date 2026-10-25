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
  ["heartbeat-checklist", "namespace is reserved for heartbeat checklist receipts"],
  ["worker", "namespace is reserved for worker nudges"],
  // Durable dedupe for SLACK_BLOCK_EXTERNAL_CHANNELS alerts (src/slack/external-channel.ts).
  ["slack-external-alert", "namespace is reserved for Slack external channel alerts"],
  // Source group labels (src/be/db/session-labels.ts). Private, see PRIVATE_FAMILIES.
  [
    "session-labels",
    "namespace is reserved for session source labels; GET /api/session-tree returns them",
  ],
]);

/**
 * Reserved families that generic KV callers may not read either. Their rows
 * hold data that another route returns only to callers with access (a
 * source label names a private channel or a DM partner).
 */
const PRIVATE_FAMILIES = new Set(["session-labels"]);

export function isReservedNamespace(namespace: string): boolean {
  return reservedNamespaceError(namespace) !== null;
}

export function reservedNamespaceError(namespace: string): string | null {
  return RESERVED_FAMILIES.get(namespace.split(":", 1)[0] ?? "") ?? null;
}

/** The error a generic KV read of a private family gets, or null. */
export function privateNamespaceError(namespace: string): string | null {
  return PRIVATE_FAMILIES.has(namespace.split(":", 1)[0] ?? "")
    ? reservedNamespaceError(namespace)
    : null;
}

export function reservedRoomKeyError(key: string): string | null {
  return key.startsWith("_room/")
    ? "room snapshot keys are reserved; use the room endpoints"
    : null;
}
