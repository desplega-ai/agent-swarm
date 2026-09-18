import { createHash } from "node:crypto";
import { claimKv } from "../be/db";
import type { AgentMailWebhookPayload } from "./types";

export const INBOUND_ARCHIVE_NAMESPACE = "agentmail-inbound";
export const inboundArchiveKey = (inboxId: string, messageId: string) =>
  createHash("sha256")
    .update(JSON.stringify([inboxId, messageId]))
    .digest("hex");

/** Persist verified deliveries before ACK, independent of task-routing filters.
 * One non-expiring entry per message; atomic insert preserves the first delivery
 * on retries. This is a delivery archive, not proof of historical completeness.
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
  await claimKv({
    namespace: INBOUND_ARCHIVE_NAMESPACE,
    key: inboundArchiveKey(message.inbox_id, message.message_id),
    value: { version: 1, capturedAt: new Date().toISOString(), payload },
    valueType: "json",
  });
}
