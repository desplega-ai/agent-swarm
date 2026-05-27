import { resolveTemplate } from "@/prompts/resolver";
import { createTaskWithSiblingAwareness } from "@/tasks/sibling-awareness";
import { workflowEventBus } from "@/workflows/event-bus";
import "@/tools/templates";
import { getKapsoNumberMapping, markKapsoMessageSeen } from "./config";

/** Minimal shape of the Kapso v2 inbound webhook payload (see the kapso-whatsapp skill). */
export interface KapsoWebhookPayload {
  message?: {
    id?: string;
    from?: string;
    type?: string;
    text?: { body?: string };
    kapso?: { direction?: string; content?: string; has_media?: boolean };
  };
  conversation?: {
    id?: string;
    phone_number?: string;
    contact_name?: string;
  };
  phone_number_id?: string;
  test?: boolean;
}

/** Outcome of routing one inbound webhook delivery. */
export type KapsoRouting =
  | { kind: "skip"; reason: string }
  | { kind: "duplicate"; messageId: string }
  | { kind: "workflow"; workflowId: string }
  | { kind: "task"; taskId: string }
  | { kind: "no_mapping"; phoneNumberId: string };

function extractText(message: NonNullable<KapsoWebhookPayload["message"]>): string {
  if (message.text?.body) return message.text.body;
  if (message.kapso?.content) return message.kapso.content;
  return `(non-text message — type: ${message.type ?? "unknown"})`;
}

function buildTaskDescription(payload: KapsoWebhookPayload): string {
  const message = payload.message ?? {};
  const conversation = payload.conversation ?? {};
  return resolveTemplate("kapso.message.received", {
    conversation_id: conversation.id ?? "unknown",
    inbound_wamid: message.id ?? "unknown",
    sender_phone: message.from ?? conversation.phone_number ?? "unknown",
    contact_name: conversation.contact_name ?? "unknown",
    phone_number_id: payload.phone_number_id ?? "unknown",
    test_note: payload.test ? "\n- test: true (do NOT send a real WhatsApp reply)" : "",
    message_text: extractText(message),
  }).text;
}

/**
 * Route one inbound Kapso webhook delivery. Pure of HTTP concerns — the caller
 * handles HMAC verification and the workflow-trigger dispatch (which needs the
 * raw body + executor registry). This:
 *   1. drops non-inbound events and deliveries missing a message id,
 *   2. dedupes by message id (KV, 24h TTL),
 *   3. emits the `kapso.message.received` workflow event (additive),
 *   4. looks up the phone-number mapping and either signals a workflow dispatch
 *      or creates a native `kapso-inbound` task,
 *   5. returns `no_mapping` when the number isn't registered (caller logs a warning).
 */
export function routeKapsoInbound(payload: KapsoWebhookPayload): KapsoRouting {
  const message = payload.message;
  const direction = message?.kapso?.direction;
  if (direction !== "inbound") {
    return { kind: "skip", reason: `non_inbound (direction=${direction ?? "none"})` };
  }

  const messageId = message?.id;
  if (!messageId) {
    return { kind: "skip", reason: "missing_message_id" };
  }

  if (!markKapsoMessageSeen(messageId)) {
    return { kind: "duplicate", messageId };
  }

  const phoneNumberId = payload.phone_number_id ?? "";

  // Additive: let event-subscribed workflows observe inbound regardless of mapping.
  workflowEventBus.emit("kapso.message.received", {
    phoneNumberId,
    conversationId: payload.conversation?.id,
    messageId,
    from: message?.from,
    type: message?.type,
    text: extractText(message ?? {}),
  });

  const mapping = phoneNumberId ? getKapsoNumberMapping(phoneNumberId) : null;
  if (!mapping) {
    return { kind: "no_mapping", phoneNumberId };
  }

  if (mapping.workflowId) {
    return { kind: "workflow", workflowId: mapping.workflowId };
  }

  const task = createTaskWithSiblingAwareness(buildTaskDescription(payload), {
    agentId: mapping.agentId ?? null,
    source: "system",
    taskType: "kapso-inbound",
    tags: ["kapso-whatsapp", "inbound"],
    priority: 70,
    contextKey: `kapso:conversation:${payload.conversation?.id ?? messageId}`,
  });

  return { kind: "task", taskId: task.id };
}
