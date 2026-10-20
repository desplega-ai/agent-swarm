/**
 * Files an agent sends to a chat thread: task attachments, read through the
 * active file provider, and agent-fs paths, read with the caller's own agent-fs
 * credential. `postChatMessage` sends them.
 */
import { getResolvedConfig, getTaskAttachments } from "@/be/db";
import { backingProviderId, scopeFromAttachment } from "@/be/task-attachment-store";
import { AgentFsProvider } from "@/fs/agent-fs-provider";
import {
  type FileScope,
  type FileStorageProvider,
  FilesError,
  normalizeStoredKey,
} from "@/fs/provider";
import { getFileStorageProvider } from "@/fs/registry";
import type { TaskAttachment } from "@/types";
import { createValueScrubber } from "@/utils/secret-scrubber";
import { SHARED_FILE_INTENT } from "./attachments";
import { errorMessage } from "./logger";
import { ChatFileTooLargeError, type OutboundChatFile } from "./outbound";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller's own agent-fs credential and default drive. Never the API's `API_AGENT_FS_API_KEY`. */
export type CallerAgentFs = { apiUrl: string; apiKey: string; orgId: string; driveId: string };

async function download(
  scope: FileScope,
  maxBytes: number,
  provider: Pick<FileStorageProvider, "download"> = getFileStorageProvider(),
): Promise<{ data: Uint8Array; mimeType?: string }> {
  const response = await provider.download(scope);
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

/**
 * The segments of a tool-supplied path, each decoded once and checked, so an
 * encoded `..`, separator, `?` or `#` cannot leave the drive or change the endpoint.
 */
function pathSegments(path: string): string[] {
  return normalizeStoredKey(path)
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // A lone `%` is part of the name; it is encoded below.
      }
      if (!decoded || decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded)) {
        throw new FilesError(
          "Provider",
          "Path must not contain empty, `.` or `..` segments, or encoded separators",
        );
      }
      return decoded;
    });
}

/** The agent-fs credential and drive the caller itself holds, or undefined when it has none. */
async function callerAgentFs(agentId: string | undefined): Promise<CallerAgentFs | undefined> {
  if (!agentId) return undefined;
  const configs = await getResolvedConfig(agentId);
  const value = (key: string) => configs.find((c) => c.key === key)?.value?.trim();
  const apiUrl = value("AGENT_FS_API_URL") || process.env.AGENT_FS_API_URL?.trim();
  const apiKey = value("AGENT_FS_API_KEY");
  const orgId = value("AGENT_FS_DEFAULT_ORG_ID");
  const driveId = value("AGENT_FS_DEFAULT_DRIVE_ID");
  return apiUrl && apiKey && orgId && driveId ? { apiUrl, apiKey, orgId, driveId } : undefined;
}

/**
 * A file at a path of the caller's agent-fs drive, read with the caller's own
 * credential: a path the caller cannot read is not sent, and the thread gets a note.
 */
export function chatFileOfPath(path: string, access: CallerAgentFs): OutboundChatFile {
  const segments = pathSegments(path);
  const name = segments.at(-1)!;
  const key = segments.map(encodeURIComponent).join("/");
  // The caller's key can be shorter than the global scrubber's floor, so a
  // storage error body or transport error is scrubbed of it by exact value.
  const keyScrubber = createValueScrubber([{ value: access.apiKey, name: "AGENT_FS_API_KEY" }]);
  return {
    name,
    load: async (maxBytes) => {
      try {
        return await download(
          { taskId: "chat", name, key, orgId: access.orgId, driveId: access.driveId },
          maxBytes,
          new AgentFsProvider(access),
        );
      } catch (error) {
        if (error instanceof ChatFileTooLargeError) throw error;
        if (error instanceof FilesError && error.code === "Unauthorized") {
          throw new Error("your agent-fs credential cannot read this path");
        }
        throw new Error(keyScrubber.text(error instanceof Error ? error.message : String(error)));
      }
    },
  };
}

/**
 * Resolve the `attachments` of `chat-reply` and `chat-post`: an attachment id
 * of `taskId`, or an agent-fs path read as `agentId`. Returns an error naming
 * the first entry that cannot be sent, so the tool refuses before posting anything.
 */
export async function resolveChatAttachmentRefs(
  refs: string[],
  taskId: string | undefined,
  agentId: string | undefined,
): Promise<{ files: OutboundChatFile[] } | { error: string }> {
  let taskAttachments: TaskAttachment[] | undefined;
  let access: CallerAgentFs | undefined | null = null;
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
    if (access === null) access = await callerAgentFs(agentId);
    if (!access) {
      return {
        error: `Path ${ref}: you have no agent-fs credential and drive to read it with. Attach the file to your task and send its attachment id.`,
      };
    }
    try {
      files.push(chatFileOfPath(ref, access));
    } catch (error) {
      return { error: `Path ${ref}: ${errorMessage(error)}` };
    }
  }
  return { files };
}

/** A Slack file an agent fetched into its task; recorded with that agent's id. */
const FETCHED_SLACK_FILE_INTENT = "slack-file";

/**
 * The output files of a task, for the result relay: attachments an agent
 * added that the active provider holds. Input files (a user's upload, a Slack
 * file an agent fetched) are left out, as the Slack relay does, so they are not
 * echoed back or carried into another chat thread.
 */
export async function taskOutputChatFiles(taskId: string): Promise<OutboundChatFile[]> {
  return (await getTaskAttachments(taskId)).flatMap((attachment) => {
    if (attachment.agentId === null) return [];
    if (
      attachment.intent === SHARED_FILE_INTENT ||
      attachment.intent === FETCHED_SLACK_FILE_INTENT
    ) {
      return [];
    }
    const file = chatFileOfTaskAttachment(attachment);
    return file ? [file] : [];
  });
}
