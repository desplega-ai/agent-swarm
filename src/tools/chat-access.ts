import * as z from "zod";
import { getAgentById, getAgentCurrentTask, getTaskById } from "@/be/db";
import { can } from "@/rbac";
import { chatThreadOfContextKey } from "@/tasks/context-key";
import type { RequestInfo } from "@/tools/utils";

/** The `attachments` input of `chat-reply` and `chat-post`. */
export const chatAttachmentsSchema = z
  .array(z.string().min(1))
  .max(10)
  .optional()
  .describe(
    "Files to send after the text, up to 10: attachment ids of your current task (from get-task-details) or file paths in your agent-fs drive, such as thoughts/<agent-id>/report.pdf, read with your own agent-fs credential. Telegram shows JPEG and PNG as photos, MP4 as video, MP3 and M4A as audio, and anything else as a document. A file over the platform upload limit (Telegram 50 MB, Discord 10 MB) is not sent, and the thread gets a note naming it.",
  );

/** Chat SDK verbs; the legacy policy grants them to the lead only. */
export type ChatVerb = "integration.chat.post" | "integration.chat.read" | "integration.chat.dm";

/**
 * The Chat SDK thread of the task the caller works on: the task named by the
 * X-Source-Task-ID header, else the agent's current task. Null when the caller
 * neither owns nor created that task, or when the task did not come from a
 * chat thread.
 */
export async function callerChatThread(
  requestInfo: RequestInfo,
): Promise<{ adapter: string; threadId: string } | null> {
  if (!requestInfo.agentId) return null;
  const task = requestInfo.sourceTaskId
    ? await getTaskById(requestInfo.sourceTaskId)
    : await getAgentCurrentTask(requestInfo.agentId);
  if (!task) return null;
  // Creator is safe: a non-lead agent can only create a chat-bound task under a parent it owns or created.
  if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
    return null;
  }
  return chatThreadOfContextKey(task.contextKey);
}

/** RBAC decision for a chat verb, with the caller's lead flag read from the database. */
export async function canUseChatVerb(requestInfo: RequestInfo, verb: ChatVerb): Promise<boolean> {
  if (!requestInfo.agentId) return false;
  const agent = await getAgentById(requestInfo.agentId);
  if (!agent) return false;
  return can({
    principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
    verb,
    resource: { kind: "none" },
    source: "mcp",
  }).allow;
}
