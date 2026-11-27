import { scrubObject } from "./utils/secret-scrubber";

/**
 * Namespace families owned by internal subsystems which write through the raw
 * DB helpers. Generic HTTP/MCP KV callers may read these namespaces for
 * inspection, but must not mutate them. A family is `<name>` and `<name>:*`,
 * mapped here to the error a generic write gets. A name may span segments
 * (`integrations:kapso`), so its siblings under `integrations:` stay writable.
 */
const RESERVED_FAMILIES = new Map([
  ["durable", "namespace holds durable object state; it is written only by object calls"],
  ["apps", "namespace is reserved for swarm apps; use the app row endpoints"],
  // step-9: Comb's "Send to swarm" claims (`comb:sent`).
  ["comb", "namespace is reserved for Comb; use POST /api/comb/review-batches"],
  // The org design system (src/themes/design-system.ts): writes must pass its token checks.
  [
    "design-system",
    "namespace is reserved for the org design system; use design-system-set or PUT /api/design-system",
  ],
  ["heartbeat-checklist", "namespace is reserved for heartbeat checklist receipts"],
  ["worker", "namespace is reserved for worker nudges"],
  // Durable dedupe for SLACK_BLOCK_EXTERNAL_CHANNELS alerts (src/slack/external-channel.ts).
  ["slack-external-alert", "namespace is reserved for Slack external channel alerts"],
  // Threads the swarm left via slack-leave-thread (src/slack/left-threads.ts).
  ["slack-left-thread", "namespace is reserved for left Slack threads; use slack-leave-thread"],
  // 👍/👎 votes on Slack outcome cards (src/slack/feedback.ts). Only a real click writes them.
  [
    "slack-feedback",
    "namespace is reserved for Slack answer feedback; votes come from Slack clicks",
  ],
  // Slack thread replies awaiting their buffer flush (src/slack/thread-buffer-store.ts). Private.
  ["slack-thread-buffer", "namespace is reserved for the Slack thread buffer"],
  // Source group labels (src/be/db/session-labels.ts). Private, see PRIVATE_FAMILIES.
  [
    "session-labels",
    "namespace is reserved for session source labels; GET /api/session-tree returns them",
  ],
  // Slack profile emails read from users.info (src/slack/enrich.ts). They decide the
  // email-domain allowlist and the Slack-to-user auto-link, so only the API writes them.
  [
    "integration:user-enrichment",
    "namespace is reserved for integration profile enrichment; the API writes it from the provider",
  ],
  // Recorded results of scripts' keyed tool calls (src/be/scripts/tool-call-idempotency.ts). Private.
  [
    "tool-call-idempotency",
    "namespace is reserved for tool call idempotency records; send an Idempotency-Key to /api/mcp-bridge",
  ],
  // Kapso number routing and inbound dedupe (src/integrations/kapso/config.ts).
  [
    "integrations:kapso",
    "namespace is reserved for Kapso routing; use register-kapso-number or unregister-kapso-number",
  ],
  // Chat SDK channel routing (src/integrations/chat-sdk/router.ts). `channel-settings` stays writable.
  [
    "integrations:chat:channels",
    "namespace is reserved for chat channel routing; use register-chat-channel or unregister-chat-channel",
  ],
]);

/**
 * Reserved families that generic KV callers may not read either. Their rows
 * hold data that another route returns only to callers with access (a
 * source label names a private channel or a DM partner; a buffered Slack
 * reply holds a message from one).
 */
const PRIVATE_FAMILIES = new Set([
  "session-labels",
  "slack-thread-buffer",
  "slack-feedback",
  // A recorded tool result can hold what only its caller may read.
  "tool-call-idempotency",
]);

/**
 * Private families a Lead agent may still read through generic KV, with the
 * error everyone else gets. A Slack vote names its voter and the task's
 * channel and thread, so only the operator's Lead reads them.
 */
const LEAD_READABLE_FAMILIES = new Map([
  ["slack-feedback", "Slack feedback votes are readable only by a Lead agent"],
]);

/**
 * Families only the Lead may write. `usecase:<key>` holds the Slack or chat
 * thread a use case reports to; the Lead posts run summaries there, so a
 * worker must not be able to point it at another thread. `workflow-suggest`
 * is the Lead's suggestion ledger; a worker write could fake a decline.
 */
const LEAD_ONLY_FAMILIES = new Set(["usecase", "workflow-suggest"]);

/** True when writes to `namespace` need a Lead agent (`kv.write.any`). */
export function requiresLeadToWrite(namespace: string): boolean {
  return LEAD_ONLY_FAMILIES.has(namespace.split(":", 1)[0] ?? "");
}

export function isReservedNamespace(namespace: string): boolean {
  return reservedNamespaceError(namespace) !== null;
}

export function reservedNamespaceError(namespace: string): string | null {
  for (const [family, error] of RESERVED_FAMILIES) {
    if (namespace === family || namespace.startsWith(`${family}:`)) return error;
  }
  return null;
}

/** The error a generic KV read of a private family gets, or null. */
export function privateNamespaceError(
  namespace: string,
  caller: { isLead?: boolean } = {},
): string | null {
  const family = namespace.split(":", 1)[0] ?? "";
  if (!PRIVATE_FAMILIES.has(family)) return null;
  const leadError = LEAD_READABLE_FAMILIES.get(family);
  if (leadError) return caller.isLead ? null : leadError;
  return reservedNamespaceError(namespace);
}

export function reservedRoomKeyError(key: string): string | null {
  return key.startsWith("_room/")
    ? "room snapshot keys are reserved; use the room endpoints"
    : null;
}

/** Scrub durable state before generic KV reads return it. */
export function scrubReservedRead(namespace: string, value: unknown): unknown {
  return namespace.split(":", 1)[0] === "durable" ? scrubObject(value) : value;
}
