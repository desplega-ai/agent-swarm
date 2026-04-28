/**
 * Jira webhook receiver.
 *
 * Auth model: Atlassian does NOT HMAC-sign OAuth 3LO dynamic webhooks. Instead
 * we embed a high-entropy random token (`JIRA_WEBHOOK_TOKEN`) in the path
 * segment of the registered webhook URL and reject deliveries whose path
 * token doesn't match (timing-safe compare). See plan errata I8.
 *
 * Dedup is DB-persisted (not a process-local Map) so it survives restarts:
 * a synthetic deliveryId derived from `webhookEvent + timestamp + entity id +
 * sha256(rawBody).slice(0,16)` is stored in `tracker_sync.lastDeliveryId`
 * after each successful processing run.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { hasTrackerDelivery, markTrackerDelivery } from "../be/db-queries/tracker";
import { handleCommentEvent, handleIssueDeleteEvent, handleIssueEvent } from "./sync";

/**
 * Timing-safe compare of two URL-path tokens. Returns `false` for any of:
 *   - missing / empty `pathToken` or `expected`
 *   - length mismatch (we still call timingSafeEqual on padded buffers to
 *     avoid leaking length via early-return timing — both arguments are
 *     zero-padded to the longer length first)
 *   - byte-for-byte mismatch
 */
export function verifyJiraWebhookToken(pathToken: string | undefined, expected: string): boolean {
  if (!pathToken || !expected) return false;

  const a = Buffer.from(pathToken, "utf8");
  const b = Buffer.from(expected, "utf8");
  const len = Math.max(a.length, b.length);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  a.copy(padA);
  b.copy(padB);

  // timingSafeEqual on equal-length padded buffers; the length-mismatch path
  // is "real != real after padding" → returns false in constant time.
  const equalBytes = timingSafeEqual(padA, padB);
  return equalBytes && a.length === b.length;
}

/**
 * Build a deliveryId from the raw body and parsed envelope. Stable across
 * retries of the same delivery. The body-hash suffix kills same-millisecond
 * collisions on different events.
 */
export function synthesizeDeliveryId(body: Record<string, unknown>, rawBody: string): string {
  const event = String(body.webhookEvent ?? "");
  const ts = String(body.timestamp ?? "");
  const issue = body.issue as { id?: unknown } | undefined;
  const comment = body.comment as { id?: unknown } | undefined;
  const entityId = String(issue?.id ?? comment?.id ?? "_");
  const hash = createHash("sha256").update(rawBody).digest("hex").slice(0, 16);
  return `${event}:${ts}:${entityId}:${hash}`;
}

/** Public form so callers (and tests) can poke the same path. */
export function isDuplicateDelivery(deliveryId: string): boolean {
  return hasTrackerDelivery("jira", deliveryId);
}

/** Mark a delivery as processed for the given Jira entity. */
export function markDelivery(externalId: string, deliveryId: string): void {
  markTrackerDelivery("jira", "task", externalId, deliveryId);
}

// ─── Top-level dispatcher ──────────────────────────────────────────────────

export type WebhookResult = {
  status: number;
  body: unknown;
};

/**
 * Process a raw Jira webhook delivery. Returns the HTTP response shape; the
 * caller owns writing it to the wire.
 *
 * Contract:
 *   - 503 when `JIRA_WEBHOOK_TOKEN` is unset.
 *   - 401 with empty body on token mismatch (no info leak).
 *   - 200 + `{status: "accepted"|"duplicate"|"ignored"}` otherwise.
 *
 * Heavy work is fire-and-forget: we always return 200 once accepted to avoid
 * Atlassian retrying on slow handlers.
 */
export async function handleJiraWebhook(
  pathToken: string | undefined,
  rawBody: string,
): Promise<WebhookResult> {
  const expected = process.env.JIRA_WEBHOOK_TOKEN;
  if (!expected) {
    return { status: 503, body: { error: "Jira webhook handler not configured" } };
  }

  if (!verifyJiraWebhookToken(pathToken, expected)) {
    // Empty body — no leakage about valid-vs-missing.
    return { status: 401, body: "" };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Jira Webhook] Malformed JSON body: ${msg}`);
    // Atlassian-side bug shouldn't trigger retries — accept and drop.
    return { status: 200, body: { status: "ignored", reason: "invalid-json" } };
  }

  const deliveryId = synthesizeDeliveryId(parsed, rawBody);
  if (isDuplicateDelivery(deliveryId)) {
    return { status: 200, body: { status: "duplicate" } };
  }

  const event = String(parsed.webhookEvent ?? "");

  // Fire-and-forget heavy work; return 200 immediately.
  void dispatchAndRecord(event, parsed, deliveryId).catch((err) => {
    console.error("[Jira Webhook] Error processing event:", err, {
      event,
      deliveryId,
    });
  });

  return { status: 200, body: { status: "accepted" } };
}

async function dispatchAndRecord(
  event: string,
  body: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const issue = body.issue as { id?: unknown } | undefined;
  const externalId = typeof issue?.id === "string" ? issue.id : null;

  switch (event) {
    case "jira:issue_updated":
      await handleIssueEvent(body);
      break;
    case "comment_created":
    case "comment_updated":
      await handleCommentEvent(body);
      break;
    case "jira:issue_deleted":
      await handleIssueDeleteEvent(body);
      break;
    default:
      console.log(`[Jira Webhook] Ignoring unhandled event: ${event}`);
      return;
  }

  // Best-effort: stamp the delivery on whichever sync row exists for this
  // entity. No-op when the handler decided not to create one.
  if (externalId) {
    markDelivery(externalId, deliveryId);
  }
}
