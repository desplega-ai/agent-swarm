/**
 * Files an agent sends to a chat thread: task attachments and agent-fs paths,
 * read through the active file provider. `postChatMessage` sends them.
 */
import { basename } from "node:path";
import { getTaskAttachments } from "@/be/db";
import { backingProviderId, scopeFromAttachment } from "@/be/task-attachment-store";
import { type FileScope, normalizeStoredKey } from "@/fs/provider";
import { getFileStorageProvider } from "@/fs/registry";
import type { TaskAttachment } from "@/types";
import { SHARED_FILE_INTENT } from "./attachments";
import { errorMessage } from "./logger";
import { ChatFileTooLargeError, type OutboundChatFile } from "./outbound";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function download(
  scope: FileScope,
  maxBytes: number,
): Promise<{ data: Uint8Array; mimeType?: string }> {
  const response = await getFileStorageProvider().download(scope);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new ChatFileTooLargeError(length);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > maxBytes) throw new ChatFileTooLargeError(data.byteLength);
  return { data, mimeType: response.headers.get("content-type") ?? undefined };
}

/** A task attachment as a file to send, or undefined when the active provider does not hold its bytes. */
export function chatFileOfTaskAttachment(attachment: TaskAttachment): OutboundChatFile | undefined {
  if (backingProviderId(attachment) !== getFileStorageProvider().id) return undefined;
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    load: (maxBytes) => download(scopeFromAttachment(attachment), maxBytes),
  };
}

/** A file at a path of the swarm's file provider (the agent-fs drive, or the local store). */
export function chatFileOfPath(path: string, taskId?: string): OutboundChatFile {
  const key = normalizeStoredKey(path);
  const name = basename(key);
  return {
    name,
    load: (maxBytes) => download({ taskId: taskId ?? "chat", name, key }, maxBytes),
  };
}

/**
 * Resolve the `attachments` of `chat-reply` and `chat-post`: an attachment id
 * of `taskId`, or a file path. Returns an error naming the first entry that
 * cannot be sent, so the tool refuses before posting anything.
 */
export async function resolveChatAttachmentRefs(
  refs: string[],
  taskId: string | undefined,
): Promise<{ files: OutboundChatFile[] } | { error: string }> {
  let taskAttachments: TaskAttachment[] | undefined;
  const files: OutboundChatFile[] = [];
  for (const ref of refs) {
    if (UUID_PATTERN.test(ref)) {
      if (!taskId) return { error: `Attachment ${ref}: no current task to look it up in.` };
      taskAttachments ??= await getTaskAttachments(taskId);
      const attachment = taskAttachments.find((a) => a.id === ref);
      if (!attachment)
        return { error: `Attachment ${ref} is not an attachment of task ${taskId}.` };
      const file = chatFileOfTaskAttachment(attachment);
      if (!file) {
        return {
          error: `Attachment ${ref} (${attachment.kind}) is not stored in the swarm file provider, so it cannot be sent as a file. Post its link instead.`,
        };
      }
      files.push(file);
      continue;
    }
    try {
      files.push(chatFileOfPath(ref, taskId));
    } catch (error) {
      return { error: `Path ${ref}: ${errorMessage(error)}` };
    }
  }
  return { files };
}

/**
 * The output files of a task, for the result relay: attachments an agent
 * added that the active provider holds. Files a user sent the bot are left
 * out, so they are not echoed back.
 */
export async function taskOutputChatFiles(taskId: string): Promise<OutboundChatFile[]> {
  return (await getTaskAttachments(taskId)).flatMap((attachment) => {
    if (attachment.agentId === null || attachment.intent === SHARED_FILE_INTENT) return [];
    const file = chatFileOfTaskAttachment(attachment);
    return file ? [file] : [];
  });
}
