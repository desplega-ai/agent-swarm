import { createHash } from "node:crypto";
import { claimKv, sweepExpiredKv } from "../be/db";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { AgentMailWebhookPayload } from "./types";

export const INBOUND_ARCHIVE_NAMESPACE = "agentmail-inbound";
export const INBOUND_ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const text = (value: unknown, limit: number) =>
  typeof value === "string" ? scrubSecrets(value).slice(0, limit) : "";

export const inboundArchiveKey = (inboxId: string, messageId: string) =>
  createHash("sha256")
    .update(JSON.stringify([inboxId, messageId]))
    .digest("hex");

/** Persist verified deliveries before ACK, independent of task-routing filters.
 * One minimized entry per message for 30 days from capture. Live retries preserve
 * the first delivery and its expiry; a replay after expiry starts a new window.
 * This is a delivery archive, not proof of historical completeness.
 */
export async function archiveInboundMessage(payload: AgentMailWebhookPayload): Promise<void> {
  if (
    ![
      "message.received",
      "message.received.unauthenticated",
      "message.received.blocked",
      "message.received.spam",
    ].includes(payload.event_type)
  )
    return;
  const message = payload.message;
  if (!message?.inbox_id || !message.message_id || !message.thread_id) {
    throw new Error("Inbound webhook missing inbox, message or thread ID");
  }
  const now = Date.now();
  // Remove expired payloads on traffic as well as the KV point-read lazy sweep.
  await sweepExpiredKv(INBOUND_ARCHIVE_NAMESPACE, now);
  const minimized = {
    event_type: payload.event_type,
    message: {
      inbox_id: message.inbox_id,
      message_id: message.message_id,
      thread_id: message.thread_id,
      from_: text(Array.isArray(message.from_) ? message.from_.join(", ") : message.from_, 1500),
      reply_to: Array.isArray(message.reply_to)
        ? message.reply_to.slice(0, 20).map((value) => text(value, 1500))
        : undefined,
      subject: text(message.subject, 300),
      text: text(message.text, 16000),
      html: text(message.html, 16000),
      timestamp: text(message.timestamp || message.created_at, 100),
      labels: Array.isArray(message.labels)
        ? message.labels.filter((label) => label === "unauthenticated")
        : [],
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map((attachment) => ({
            filename: text(attachment.filename, 1500),
            content_type: text(attachment.content_type, 200),
            size: typeof attachment.size === "number" ? attachment.size : null,
          }))
        : undefined,
    },
  };
  await claimKv({
    namespace: INBOUND_ARCHIVE_NAMESPACE,
    key: inboundArchiveKey(message.inbox_id, message.message_id),
    value: { version: 1, capturedAt: new Date(now).toISOString(), payload: minimized },
    expiresAt: now + INBOUND_ARCHIVE_TTL_MS,
    valueType: "json",
  });
}
