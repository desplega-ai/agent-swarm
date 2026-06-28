import { createHmac, timingSafeEqual } from "node:crypto";
import {
  handleAgentSessionEvent,
  handleAgentSessionPrompted,
  handleIssueDelete,
  handleIssueUpdate,
} from "./sync";

// In-memory dedup set for Linear-Delivery header
const recentDeliveries = new Map<string, number>(); // deliveryId -> timestamp
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupDeliveries(): void {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [id, ts] of recentDeliveries) {
    if (ts < cutoff) recentDeliveries.delete(id);
  }
}

/** Exported for testing — not part of the public API */
export function _getRecentDeliveries(): Map<string, number> {
  return recentDeliveries;
}

/** Exported for testing — not part of the public API */
export function _clearRecentDeliveries(): void {
  recentDeliveries.clear();
}

export function verifyLinearWebhook(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function processWebhookEvent(
  event: Record<string, unknown>,
  deliveryId?: string,
): Promise<void> {
  const { type, action } = event;

  // Handle AgentSession events (Linear Agent SDK)
  if (type === "AgentSessionEvent" || type === "AgentSession") {
    if (action === "prompted") {
      await handleAgentSessionPrompted(event);
      return;
    }
    await handleAgentSessionEvent(event);
    return;
  }

  // Handle Issue events
  if (type === "Issue") {
    if (action === "update") {
      await handleIssueUpdate(event, deliveryId);
    } else if (action === "remove") {
      await handleIssueDelete(event);
    }
    return;
  }
}

export async function handleLinearWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  const signingSecret = process.env.LINEAR_SIGNING_SECRET;
  if (!signingSecret) {
    return { status: 503, body: { error: "Linear webhook not configured" } };
  }

  // 1. Verify signature
  const signature = headers["linear-signature"] ?? headers["x-linear-signature"];
  if (!signature || !verifyLinearWebhook(rawBody, signature, signingSecret)) {
    return { status: 401, body: { error: "Invalid signature" } };
  }

  // 2. Dedup via Linear-Delivery header
  cleanupDeliveries();
  const deliveryId = headers["linear-delivery"];
  if (deliveryId) {
    if (recentDeliveries.has(deliveryId)) {
      return { status: 200, body: { status: "duplicate" } };
    }
    recentDeliveries.set(deliveryId, Date.now());
  }

  // 3. Parse and dispatch
  const event = JSON.parse(rawBody) as Record<string, unknown>;

  // Fire-and-forget for heavy work
  processWebhookEvent(event, deliveryId ?? undefined).catch((err) => {
    console.error("[Linear Webhook] Error processing event:", err, {
      type: event.type,
      action: event.action,
      deliveryId,
    });
  });

  return { status: 200, body: { status: "accepted" } };
}
