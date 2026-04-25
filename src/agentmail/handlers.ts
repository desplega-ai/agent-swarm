import {
  findTaskByAgentMailThread,
  getAgentById,
  getAgentMailInboxMapping,
  getAllAgents,
  resolveUser,
} from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { createIngressBuffer } from "../tasks/additive-ingress";
import { agentmailContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { workflowEventBus } from "../workflows/event-bus";
// Side-effect import: registers all AgentMail event templates in the in-memory registry
import "./templates";
import type { AgentMailMessage, AgentMailWebhookPayload } from "./types";

const ACTIVE_TASK_STATUSES = new Set(["pending", "in_progress", "offered", "paused"]);

interface BufferedAgentMailMessage {
  from: string;
  subject: string;
  inboxId: string;
  threadId: string;
  messageId: string;
  preview: string;
  agentId: string | null;
  parentTaskId: string;
  requestedByUserId: string | undefined;
}

const AGENTMAIL_BUFFER_TIMEOUT_MS = Number(process.env.ADDITIVE_AGENTMAIL_BUFFER_MS) || 10_000;

const agentmailBuffer = createIngressBuffer<BufferedAgentMailMessage>({
  source: "agentmail",
  envFlag: "ADDITIVE_AGENTMAIL",
  timeoutMs: AGENTMAIL_BUFFER_TIMEOUT_MS,
  onFlush: (items, contextKey) => {
    if (items.length === 0) return;
    const first = items[0]!;
    const combinedPreview = items.map((m) => m.preview).join("\n---\n");
    const followupResult = resolveTemplate("agentmail.email.followup", {
      from: first.from,
      subject: first.subject,
      inbox_id: first.inboxId,
      thread_id: first.threadId,
      preview: `[${items.length} buffered message(s)]\n\n${combinedPreview}`,
    });
    if (followupResult.skipped) return;
    const task = createTaskWithSiblingAwareness(followupResult.text, {
      agentId: first.agentId,
      source: "agentmail",
      taskType: "agentmail-reply",
      agentmailInboxId: first.inboxId,
      agentmailMessageId: first.messageId,
      agentmailThreadId: first.threadId,
      parentTaskId: first.parentTaskId,
      requestedByUserId: first.requestedByUserId,
      contextKey,
    });
    console.log(
      `[AgentMail] Buffered flush → task ${task.id} (${items.length} messages, thread ${first.threadId})`,
    );
  },
});

/**
 * Extract bare email address from a from_ field like "Taras Yarema <t@desplega.ai>" or "t@desplega.ai".
 */
function extractEmailFromField(from: string): string | undefined {
  const angleMatch = from.match(/<([^>]+@[^>]+)>/);
  if (angleMatch?.[1]) return angleMatch[1].toLowerCase();
  const bareMatch = from.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return bareMatch?.[0]?.toLowerCase();
}

/**
 * Check if an inbox domain is allowed by the filter.
 * Returns true if no filter is set or the inbox domain matches.
 */
export function isInboxAllowed(inboxId: string, filter: string | undefined): boolean {
  if (!filter) return true;
  const allowedDomains = filter.split(",").map((d) => d.trim().toLowerCase());
  const inboxDomain = inboxId.split("@")[1]?.toLowerCase();
  return !!inboxDomain && allowedDomains.includes(inboxDomain);
}

/**
 * Check if a sender domain is allowed by the filter.
 * Returns true if no filter is set or at least one sender domain matches.
 */
export function isSenderAllowed(
  from: AgentMailMessage["from_"],
  filter: string | undefined,
): boolean {
  if (!filter) return true;
  const allowedDomains = filter.split(",").map((d) => d.trim().toLowerCase());
  const fromAddresses = Array.isArray(from) ? from : [from || ""];
  return fromAddresses.some((addr) => {
    const emailMatch = addr.match(/<([^>]+)>/);
    const email = emailMatch?.[1] ?? addr;
    const domain = email.split("@")[1]?.toLowerCase();
    return !!domain && allowedDomains.includes(domain);
  });
}

// Simple deduplication cache (60 second TTL)
const processedEvents = new Map<string, number>();
const EVENT_TTL = 60_000;

function isDuplicate(eventKey: string): boolean {
  const now = Date.now();

  // Clean old entries
  for (const [key, timestamp] of processedEvents) {
    if (now - timestamp > EVENT_TTL) {
      processedEvents.delete(key);
    }
  }

  if (processedEvents.has(eventKey)) {
    return true;
  }

  processedEvents.set(eventKey, now);
  return false;
}

/**
 * Find the lead agent to receive AgentMail messages when no inbox mapping exists
 */
function findLeadAgent() {
  const agents = getAllAgents();
  const onlineLead = agents.find((a) => a.isLead && a.status !== "offline");
  if (onlineLead) return onlineLead;
  return agents.find((a) => a.isLead) ?? null;
}

/**
 * Handle message.received webhook event
 */
export async function handleMessageReceived(
  payload: AgentMailWebhookPayload,
): Promise<{ created: boolean; taskId?: string }> {
  const message = payload.message;
  if (!message) {
    console.log("[AgentMail] message.received event missing message payload");
    return { created: false };
  }

  // Deduplicate using event_id
  if (isDuplicate(`agentmail:${payload.event_id}`)) {
    console.log(`[AgentMail] Duplicate event ${payload.event_id}, skipping`);
    return { created: false };
  }

  const { inbox_id, thread_id, message_id } = message;
  const from =
    (Array.isArray(message.from_) ? message.from_.join(", ") : message.from_) || "unknown";
  const subject = message.subject || "(no subject)";
  const body = message.text || message.html || "";

  // Resolve canonical user from sender email
  const senderEmail = extractEmailFromField(from);
  const requestedByUserId = senderEmail ? resolveUser({ email: senderEmail })?.id : undefined;
  const preview = body.length > 500 ? `${body.substring(0, 500)}...` : body;

  // Emit workflow trigger event
  workflowEventBus.emit("agentmail.message.received", {
    inboxId: inbox_id,
    from,
    subject,
    body: preview,
    threadId: thread_id,
    messageId: message_id,
  });

  // Check for thread continuity - find existing task for this thread
  const existingTask = findTaskByAgentMailThread(thread_id);
  if (existingTask) {
    const contextKey = agentmailContextKey({ threadId: thread_id });
    const siblingInFlight = ACTIVE_TASK_STATUSES.has(existingTask.status);

    // Opt-in: when ADDITIVE_AGENTMAIL is true, buffer rapid follow-ups while
    // the prior task is still running — coalesce into ONE follow-up task.
    if (
      agentmailBuffer.enabled &&
      agentmailBuffer.maybeBuffer(contextKey, siblingInFlight, {
        from,
        subject,
        inboxId: inbox_id,
        threadId: thread_id,
        messageId: message_id,
        preview,
        agentId: existingTask.agentId,
        parentTaskId: existingTask.id,
        requestedByUserId,
      })
    ) {
      console.log(
        `[AgentMail] Buffered follow-up for thread ${thread_id} (parent ${existingTask.id}, status ${existingTask.status})`,
      );
      return { created: false };
    }

    // Create a follow-up task with parentTaskId to continue the session
    const followupResult = resolveTemplate("agentmail.email.followup", {
      from,
      subject,
      inbox_id,
      thread_id,
      preview,
    });

    if (followupResult.skipped) {
      return { created: false };
    }

    const task = createTaskWithSiblingAwareness(followupResult.text, {
      agentId: existingTask.agentId,
      source: "agentmail",
      taskType: "agentmail-reply",
      agentmailInboxId: inbox_id,
      agentmailMessageId: message_id,
      agentmailThreadId: thread_id,
      parentTaskId: existingTask.id,
      requestedByUserId,
      contextKey,
    });

    console.log(
      `[AgentMail] Created follow-up task ${task.id} for thread ${thread_id} (parent: ${existingTask.id})`,
    );
    return { created: true, taskId: task.id };
  }

  // Look up agent from inbox mapping
  const mapping = getAgentMailInboxMapping(inbox_id);

  if (mapping) {
    const agent = getAgentById(mapping.agentId);
    if (agent) {
      if (agent.isLead) {
        // Route to lead as task
        const leadResult = resolveTemplate("agentmail.email.mapped_lead", {
          from,
          subject,
          inbox_id,
          thread_id,
          message_id,
          preview,
        });

        if (leadResult.skipped) {
          return { created: false };
        }

        const task = createTaskWithSiblingAwareness(leadResult.text, {
          agentId: agent.id,
          source: "agentmail",
          taskType: "agentmail-message",
          agentmailInboxId: inbox_id,
          agentmailMessageId: message_id,
          agentmailThreadId: thread_id,
          requestedByUserId,
          contextKey: agentmailContextKey({ threadId: thread_id }),
        });

        console.log(
          `[AgentMail] Created task ${task.id} for lead ${agent.name} (inbox: ${inbox_id})`,
        );
        return { created: true, taskId: task.id };
      }

      // Route to worker as task
      const workerResult = resolveTemplate("agentmail.email.mapped_worker", {
        from,
        subject,
        inbox_id,
        thread_id,
        preview,
      });

      if (workerResult.skipped) {
        return { created: false };
      }

      const task = createTaskWithSiblingAwareness(workerResult.text, {
        agentId: agent.id,
        source: "agentmail",
        taskType: "agentmail-message",
        agentmailInboxId: inbox_id,
        agentmailMessageId: message_id,
        agentmailThreadId: thread_id,
        requestedByUserId,
        contextKey: agentmailContextKey({ threadId: thread_id }),
      });

      console.log(
        `[AgentMail] Created task ${task.id} for worker ${agent.name} (inbox: ${inbox_id})`,
      );
      return { created: true, taskId: task.id };
    }
  }

  // No mapping found - route to lead as task
  const lead = findLeadAgent();
  if (lead) {
    const unmappedResult = resolveTemplate("agentmail.email.unmapped", {
      from,
      subject,
      inbox_id,
      thread_id,
      message_id,
      preview,
    });

    if (unmappedResult.skipped) {
      return { created: false };
    }

    const task = createTaskWithSiblingAwareness(unmappedResult.text, {
      agentId: lead.id,
      source: "agentmail",
      taskType: "agentmail-message",
      agentmailInboxId: inbox_id,
      agentmailMessageId: message_id,
      agentmailThreadId: thread_id,
      requestedByUserId,
      contextKey: agentmailContextKey({ threadId: thread_id }),
    });

    console.log(
      `[AgentMail] Created task ${task.id} for lead ${lead.name} (unmapped inbox: ${inbox_id})`,
    );
    return { created: true, taskId: task.id };
  }

  // No lead available - create unassigned task
  const noAgentResult = resolveTemplate("agentmail.email.no_agent", {
    from,
    subject,
    inbox_id,
    thread_id,
    preview,
  });

  if (noAgentResult.skipped) {
    return { created: false };
  }

  const task = createTaskWithSiblingAwareness(noAgentResult.text, {
    source: "agentmail",
    taskType: "agentmail-message",
    agentmailInboxId: inbox_id,
    agentmailMessageId: message_id,
    agentmailThreadId: thread_id,
    requestedByUserId,
    contextKey: agentmailContextKey({ threadId: thread_id }),
  });

  console.log(`[AgentMail] Created unassigned task ${task.id} (no lead or mapping available)`);
  return { created: true, taskId: task.id };
}
