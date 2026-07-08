import { resolveTemplate } from "@/prompts/resolver";
import { createTaskWithSiblingAwareness } from "@/tasks/sibling-awareness";
import { workflowEventBus } from "@/workflows/event-bus";
import "@/tools/templates";
import { type IdentityResolution, renderIdentity, resolveIdentity } from "@/be/identity";
import { recordUnmappedIdentity } from "@/be/unmapped-identities";
import { getKapsoNumberMapping, markKapsoMessageSeen } from "./config";

const KAPSO_IDENTITY_KIND = "kapso";
const WHATSAPP_IDENTITY_KIND = "whatsapp";

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
  const externalId = normalizeKapsoSender(payload);
  const contactDisplay = externalId
    ? renderIdentity(resolveKapsoIdentity(externalId))
    : "(unknown user)";
  return resolveTemplate("kapso.message.received", {
    conversation_id: conversation.id ?? "unknown",
    inbound_wamid: message.id ?? "unknown",
    sender_phone: message.from ?? conversation.phone_number ?? "unknown",
    contact_name: contactDisplay,
    phone_number_id: payload.phone_number_id ?? "unknown",
    test_note: payload.test ? "\n- test: true (do NOT send a real WhatsApp reply)" : "",
    message_text: extractText(message),
  }).text;
}

function normalizeKapsoSender(payload: KapsoWebhookPayload): string | null {
  const raw = payload.message?.from ?? payload.conversation?.phone_number ?? "";
  const digits = raw.replace(/\D/g, "");
  return digits || null;
}

/**
 * Reverse-lookup a phone-number externalId across both identity kinds this
 * integration writes (`kapso`, `whatsapp` — see the dual-kind note on
 * `resolveKapsoRequestedByUserId`). Never a provider profile label.
 */
function resolveKapsoIdentity(externalId: string): IdentityResolution {
  const kapsoResolution = resolveIdentity(KAPSO_IDENTITY_KIND, externalId);
  if (kapsoResolution.status === "resolved") return kapsoResolution;
  const whatsappResolution = resolveIdentity(WHATSAPP_IDENTITY_KIND, externalId);
  if (whatsappResolution.status === "resolved") return whatsappResolution;
  // Both unknown — report under the `kapso` kind for consistency with
  // resolveKapsoRequestedByUserId's unmapped-tracker recording.
  return kapsoResolution;
}

function resolveKapsoRequestedByUserId(payload: KapsoWebhookPayload): string | undefined {
  const externalId = normalizeKapsoSender(payload);
  if (!externalId) return undefined;

  const resolution = resolveKapsoIdentity(externalId);
  if (resolution.status === "resolved") return resolution.userId;

  recordUnmappedIdentity(KAPSO_IDENTITY_KIND, externalId, {
    sampleEventType: "kapso.message.received",
    sampleContext: [
      payload.conversation?.contact_name ? `contact=${payload.conversation.contact_name}` : null,
      payload.conversation?.id ? `conversation=${payload.conversation.id}` : null,
      payload.message?.id ? `message=${payload.message.id}` : null,
      payload.phone_number_id ? `phone_number_id=${payload.phone_number_id}` : null,
    ]
      .filter(Boolean)
      .join(" "),
  });

  return undefined;
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
    requestedByUserId: resolveKapsoRequestedByUserId(payload),
    contextKey: `kapso:conversation:${payload.conversation?.id ?? messageId}`,
  });

  return { kind: "task", taskId: task.id };
}
