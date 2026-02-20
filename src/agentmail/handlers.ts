import {
  createInboxMessage,
  createTaskExtended,
  findTaskByAgentMailThread,
  getAgentById,
  getAgentMailInboxMapping,
  getAllAgents,
} from "../be/db";
import type { AgentMailWebhookPayload } from "./types";

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
): Promise<{ created: boolean; taskId?: string; inboxMessageId?: string }> {
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
  const preview = body.length > 500 ? `${body.substring(0, 500)}...` : body;

  // Check for thread continuity - find existing task for this thread
  const existingTask = findTaskByAgentMailThread(thread_id);
  if (existingTask) {
    // Create a follow-up task with parentTaskId to continue the session
    const taskDescription = `[AgentMail] Follow-up email in thread\n\nFrom: ${from}\nSubject: ${subject}\nInbox: ${inbox_id}\nThread: ${thread_id}\n\n${preview}`;

    const task = createTaskExtended(taskDescription, {
      agentId: existingTask.agentId,
      source: "agentmail",
      taskType: "agentmail-reply",
      agentmailInboxId: inbox_id,
      agentmailMessageId: message_id,
      agentmailThreadId: thread_id,
      parentTaskId: existingTask.id,
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
        // Route to lead as inbox message
        const content = `[AgentMail] New email received\n\nFrom: ${from}\nSubject: ${subject}\nInbox: ${inbox_id}\nThread: ${thread_id}\nMessage: ${message_id}\n\n${preview}`;

        const inboxMsg = createInboxMessage(agent.id, content, {
          source: "agentmail",
          matchedText: `AgentMail inbox ${inbox_id}`,
        });

        console.log(
          `[AgentMail] Created inbox message ${inboxMsg.id} for lead ${agent.name} (inbox: ${inbox_id})`,
        );
        return { created: true, inboxMessageId: inboxMsg.id };
      }

      // Route to worker as task
      const taskDescription = `[AgentMail] New email received\n\nFrom: ${from}\nSubject: ${subject}\nInbox: ${inbox_id}\nThread: ${thread_id}\n\n${preview}`;

      const task = createTaskExtended(taskDescription, {
        agentId: agent.id,
        source: "agentmail",
        taskType: "agentmail-message",
        agentmailInboxId: inbox_id,
        agentmailMessageId: message_id,
        agentmailThreadId: thread_id,
      });

      console.log(
        `[AgentMail] Created task ${task.id} for worker ${agent.name} (inbox: ${inbox_id})`,
      );
      return { created: true, taskId: task.id };
    }
  }

  // No mapping found - route to lead as inbox message
  const lead = findLeadAgent();
  if (lead) {
    const content = `[AgentMail] New email received (unmapped inbox)\n\nFrom: ${from}\nSubject: ${subject}\nInbox: ${inbox_id}\nThread: ${thread_id}\nMessage: ${message_id}\n\n${preview}`;

    const inboxMsg = createInboxMessage(lead.id, content, {
      source: "agentmail",
      matchedText: `AgentMail inbox ${inbox_id} (no mapping)`,
    });

    console.log(
      `[AgentMail] Created inbox message ${inboxMsg.id} for lead ${lead.name} (unmapped inbox: ${inbox_id})`,
    );
    return { created: true, inboxMessageId: inboxMsg.id };
  }

  // No lead available - create unassigned task
  const taskDescription = `[AgentMail] New email received (no agent available)\n\nFrom: ${from}\nSubject: ${subject}\nInbox: ${inbox_id}\nThread: ${thread_id}\n\n${preview}`;

  const task = createTaskExtended(taskDescription, {
    source: "agentmail",
    taskType: "agentmail-message",
    agentmailInboxId: inbox_id,
    agentmailMessageId: message_id,
    agentmailThreadId: thread_id,
  });

  console.log(`[AgentMail] Created unassigned task ${task.id} (no lead or mapping available)`);
  return { created: true, taskId: task.id };
}
