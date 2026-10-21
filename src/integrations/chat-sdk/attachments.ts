/**
 * Chat SDK attachments turned into task attachments. A copy of the Slack
 * inbound-files flow (`src/slack/inbound-files.ts`), not an extraction: the
 * Slack integration is left as is.
 *
 * Each attachment is fetched once per buffer flush through the adapter's own
 * `fetchData()` (it carries the platform auth), spooled to a temp file, then
 * stored through the active file provider and recorded as a `task_attachments`
 * row. The task is created in `draft` while its uploads run, with its lease
 * renewed, so no worker can claim it before its attachments exist. Every file
 * also stays in the task text as a `[File: ...]` line. Only a fetch failure is
 * flagged there; upload and record failures are logged. Audio files (voice
 * notes) get their transcript in the task text when transcription is
 * configured, and keep the audio attached.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "chat";
import { getTaskAttachments, promoteDraftTask, refreshDraftTaskLease } from "@/be/db";
import { MAX_TASK_ATTACHMENT_BYTES, recordTaskAttachmentUpload } from "@/be/task-attachment-store";
import { providerPath } from "@/fs/provider";
import { getFileStorageProvider } from "@/fs/registry";
import { createTaskWithSiblingAwareness } from "@/tasks/sibling-awareness";
import type { AgentTask, CreateTaskOptions } from "@/types";
import { transcribeAudioNotes } from "@/utils/transcription";
import { errorMessage } from "./logger";

/** How often a draft's lease is renewed while its uploads run; the sweep waits 5 minutes. */
const DRAFT_LEASE_REFRESH_MS = 60_000;
/** A file a user sent the bot, like one uploaded from the dashboard composer. */
export const SHARED_FILE_INTENT = "user-upload";

const MB = 1024 * 1024;
/**
 * Per-file inbound cap by adapter. A Telegram bot can download at most 20 MB
 * through `getFile`; a larger file fails at Telegram before our own cap.
 * Other adapters use the task attachment cap.
 */
const CHAT_INBOUND_FILE_LIMITS: Record<string, number> = { telegram: 20 * MB };

export function chatInboundFileLimit(adapter: string): number {
  return Math.min(
    CHAT_INBOUND_FILE_LIMITS[adapter] ?? MAX_TASK_ATTACHMENT_BYTES,
    MAX_TASK_ATTACHMENT_BYTES,
  );
}

/**
 * One attachment of a buffered chat message. `id` is `<messageId>-<n>` with
 * every character outside `[A-Za-z0-9_.-]` replaced by `_` (Telegram message
 * ids carry the chat id and a colon); it names the stored blob.
 */
export interface ChatFile {
  id: string;
  adapter: string;
  messageId: string;
  name: string;
  mimeType?: string;
  size?: number;
  attachment: Attachment;
}

/** `tooLarge` marks a file over the inbound cap; the user gets a reply naming it. */
export type ChatFileFailure = { file: ChatFile; reason: string; tooLarge?: boolean };

export type FetchedChatFile = { file: ChatFile; path: string; sizeBytes: number; sha256: string };

export type InboundChatFiles = {
  files: ChatFile[];
  fetched: FetchedChatFile[];
  failed: ChatFileFailure[];
  /** Deletes the downloaded copies; hold the batch with `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Describe the attachments of one message as `ChatFile`s. */
export function toChatFiles(
  adapter: string,
  messageId: string,
  attachments: Attachment[],
): ChatFile[] {
  return attachments.map((attachment, index) => ({
    id: `${messageId}-${index + 1}`.replace(/[^\w.-]/g, "_"),
    adapter,
    messageId,
    name: attachment.name ?? `${attachment.type}-${index + 1}`,
    mimeType: attachment.mimeType,
    size: attachment.size,
    attachment,
  }));
}

/**
 * `[File: <name> (<mime>, <size>) id=<id>]` per file, followed by
 * `(not attached: <reason>)` when the file never reached the task, and by the
 * file's note (a voice-note transcript) on the next line.
 */
export function buildChatAttachmentText(
  files: ChatFile[],
  failed: ChatFileFailure[] = [],
  notes: Map<string, string> = new Map(),
): string {
  const reasons = new Map(failed.map((f) => [f.file.id, f.reason]));
  return files
    .map((f) => {
      const size = typeof f.size === "number" ? formatFileSize(f.size) : "unknown size";
      const line = `[File: ${f.name} (${f.mimeType ?? "unknown type"}, ${size}) id=${f.id}]`;
      const reason = reasons.get(f.id);
      const note = notes.get(f.id);
      return [reason ? `${line} (not attached: ${reason})` : line, note].filter(Boolean).join("\n");
    })
    .join("\n");
}

/**
 * A sender-chosen file name as an inline code span, so the bot's reply shows it
 * as literal text and never renders a link, image or heading from it. Backslash
 * escapes are not enough: the Chat SDK parser still autolinks bare URLs.
 */
function markdownLiteral(value: string): string {
  const text = value.replace(/[\r\n]+/g, " ");
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  // CommonMark strips one space from each end of a padded span.
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The reply posted to the thread when files were over the inbound cap. */
export function formatTooLargeReply(failed: ChatFileFailure[]): string {
  const lines = failed.map((f) => `- ${markdownLiteral(f.file.name)}: ${f.reason}`);
  return [
    `Too large to read, so the swarm did not get ${failed.length === 1 ? "this file" : "these files"}:`,
    ...lines,
    "Send a smaller file or a link.",
  ].join("\n");
}

/**
 * Transcribe every fetched audio file. Returns one task-text note per file:
 * the transcript, the failure, or (when no provider is configured) a line
 * saying so. Never throws.
 */
export async function transcribeChatAudio(
  fetched: FetchedChatFile[],
): Promise<Map<string, string>> {
  return transcribeAudioNotes(
    fetched
      .filter(({ file }) => file.attachment.type === "audio")
      .map(({ file, path }) => ({
        key: file.id,
        name: file.name,
        data: Bun.file(path),
        mimeType: file.mimeType,
      })),
    "[chat-sdk]",
  );
}

async function readAttachment(attachment: Attachment): Promise<Uint8Array> {
  if (attachment.data instanceof Blob) return new Uint8Array(await attachment.data.arrayBuffer());
  if (attachment.data) return new Uint8Array(attachment.data);
  if (!attachment.fetchData) throw new Error("the adapter gave no way to download it");
  const data = await attachment.fetchData();
  return new Uint8Array(data);
}

/**
 * Download every attachment, each to its own temp file. Never throws: a file
 * that cannot be fetched lands in `failed` with a readable reason.
 */
export async function fetchChatFiles(files: ChatFile[]): Promise<InboundChatFiles> {
  let dir: string | undefined;
  const result: InboundChatFiles = {
    files,
    fetched: [],
    failed: [],
    async [Symbol.asyncDispose]() {
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
  if (files.length === 0) return result;

  const tooLarge = (file: ChatFile, size: number): ChatFileFailure => {
    const limit = chatInboundFileLimit(file.adapter);
    const platform = file.adapter.charAt(0).toUpperCase() + file.adapter.slice(1);
    return {
      file,
      reason: `too large (${formatFileSize(size)}, the limit for files sent to the ${platform} bot is ${formatFileSize(limit)})`,
      tooLarge: true,
    };
  };
  dir = await mkdtemp(join(tmpdir(), "chat-files-"));
  for (const [index, file] of files.entries()) {
    if (typeof file.size === "number" && file.size > chatInboundFileLimit(file.adapter)) {
      result.failed.push(tooLarge(file, file.size));
      continue;
    }
    try {
      const bytes = await readAttachment(file.attachment);
      if (bytes.byteLength > chatInboundFileLimit(file.adapter)) {
        result.failed.push(tooLarge(file, bytes.byteLength));
        continue;
      }
      const path = join(dir, String(index));
      await Bun.write(path, bytes);
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      file.size ??= bytes.byteLength;
      result.fetched.push({ file, path, sizeBytes: bytes.byteLength, sha256 });
    } catch (error) {
      const reason = `download failed (${errorMessage(error)})`;
      console.warn(`[chat-sdk] could not fetch file ${file.id}: ${reason}`);
      result.failed.push({ file, reason });
    }
  }
  return result;
}

/**
 * Create a chat-sourced task and attach the fetched files. Without files this
 * is `createTaskWithSiblingAwareness`. With files the task is created in
 * `draft` and promoted once every upload has settled, success or not.
 */
export async function createChatTaskWithFiles(
  description: string,
  options: CreateTaskOptions,
  inbound: InboundChatFiles,
): Promise<{ task: AgentTask; unattached: ChatFileFailure[] }> {
  if (inbound.fetched.length === 0) {
    const task = await createTaskWithSiblingAwareness(description, options, { origin: "webhook" });
    return { task, unattached: inbound.failed };
  }

  const task = await createTaskWithSiblingAwareness(
    description,
    { ...options, status: "draft" },
    { origin: "webhook" },
  );
  const unattached = [...inbound.failed];
  const lease = setInterval(() => {
    void refreshDraftTaskLease(task.id).catch((error) =>
      console.warn(
        `[chat-sdk] could not renew the draft lease of task ${task.id}: ${errorMessage(error)}`,
      ),
    );
  }, DRAFT_LEASE_REFRESH_MS);
  try {
    unattached.push(...(await attachChatFilesToTask(task.id, inbound.fetched)));
  } finally {
    clearInterval(lease);
    await promoteDraftTask(task.id);
  }
  return { task, unattached };
}

/**
 * Store fetched chat files as attachments of a task. A file whose bytes the
 * task already holds is reused. Returns the files that could not be stored.
 */
export async function attachChatFilesToTask(
  taskId: string,
  fetched: FetchedChatFile[],
): Promise<ChatFileFailure[]> {
  const existing = await getTaskAttachments(taskId);
  const bySha = new Set(existing.flatMap((a) => (a.sha256 ? [a.sha256] : [])));
  const usedNames = new Set(existing.map((a) => a.name));
  const provider = getFileStorageProvider();
  const unattached: ChatFileFailure[] = [];

  for (const { file, path, sizeBytes, sha256 } of fetched) {
    if (bySha.has(sha256)) continue;
    const name = usedNames.has(file.name) ? `${file.id}-${file.name}` : file.name;
    usedNames.add(name);
    const key = providerPath({ taskId, name: `chat-${file.id}-${file.name}` });
    const scope = { taskId, name, key };
    const contentType = file.mimeType ?? "application/octet-stream";
    try {
      const uploaded = await provider.upload(scope, Bun.file(path), {
        contentType,
        sizeBytes,
        message: `Upload ${name} from ${file.adapter} for task ${taskId}`,
      });
      await recordTaskAttachmentUpload({
        provider,
        scope,
        uploaded,
        sizeBytes,
        sha256,
        contentType,
        agentId: null,
        intent: SHARED_FILE_INTENT,
        description: `Shared on ${file.adapter} (message ${file.messageId})`,
      });
      bySha.add(sha256);
    } catch (error) {
      const reason = `could not be stored (${errorMessage(error)})`;
      console.warn(`[chat-sdk] file ${file.id} for task ${taskId} ${reason}`);
      unattached.push({ file, reason });
    }
  }
  return unattached;
}
