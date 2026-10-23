import type { Attachment, FileUpload } from "chat";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { workflowEventBus } from "@/workflows/event-bus";
import { formatFileSize } from "./attachments";
import {
  CHAT_FILES_PER_MESSAGE,
  chatMessageLimit,
  chatUploadLimit,
  splitChatMessage,
  TELEGRAM_PHOTO_LIMIT,
} from "./limits";
import { errorMessage } from "./logger";
import { getChatInstance } from "./runtime";
import { assertTrustedChatTarget } from "./teams-origin";

/** The adapter is not configured, failed to start, or is shutting down. */
export class ChatAdapterUnavailableError extends Error {
  constructor(adapter: string) {
    super(`Chat SDK adapter '${adapter}' is not running`);
    this.name = "ChatAdapterUnavailableError";
  }
}

export interface ChatSentEvent {
  adapter: string;
  channelId: string;
  threadId: string;
  text: string;
  taskId?: string;
  messageId?: string;
}

/**
 * Publish an outbound message on the bus. The post-bridge turns it into the
 * `post.chat.message` extension event with `direction: "outbound"`.
 */
export function emitChatMessageSent(event: ChatSentEvent): void {
  workflowEventBus.emit("chat.message.sent", { ...event, text: scrubSecrets(event.text) });
}

/** The adapter name is the first segment of an SDK thread or channel id. */
export function adapterOfChatId(id: string): string {
  const index = id.indexOf(":");
  return index === -1 ? id : id.slice(0, index);
}

export interface ChatPostResult {
  adapter: string;
  threadId: string;
  channelId: string;
  /** One id per chunk and per file message, in send order. */
  messageIds: string[];
  /** Files that did not reach the thread. The thread got a note naming each one. */
  unsentFiles: UnsentChatFile[];
}

/** A file to send after the text. `load` reads its bytes. */
export interface OutboundChatFile {
  name: string;
  mimeType?: string;
  /** Size known before loading, so an oversized file is never read. */
  sizeBytes?: number;
  /** Throws `ChatFileTooLargeError` when the file is larger than `maxBytes`. */
  load(maxBytes: number): Promise<{ data: Uint8Array; mimeType?: string }>;
}

export interface UnsentChatFile {
  name: string;
  reason: string;
}

export class ChatFileTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(`file is ${formatFileSize(sizeBytes)}`);
    this.name = "ChatFileTooLargeError";
  }
}

type SentChunk = { id: string; threadId?: string };

interface PostTarget {
  post(message: {
    markdown: string;
    files?: FileUpload[];
    attachments?: Attachment[];
  }): Promise<SentChunk>;
}

/** A fence opener or closer: up to 3 spaces, then 3+ backticks or tildes. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
/**
 * A `#` run at the start of a line's text (after blockquote, list and task
 * markers) that CommonMark does not read as a heading: 7+ `#`, or `#` followed
 * by a character other than whitespace or `#`.
 */
const NON_HEADING_HASH =
  /^( {0,3}(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?)(#{7,}|#{1,6}(?=[^\s#]))/;

/**
 * Telegram renders `{ markdown }` posts with `sendRichMessage`, and Telegram's
 * own Markdown parser reads a line-leading `#2203` or `#tag` as a heading.
 * Escape the first `#` of such a line so only CommonMark ATX headings
 * (`# Title`) stay headings. Fenced code is left as is. The MarkdownV2
 * fallback parses the escape back to a literal `#`.
 */
export function escapeTelegramHashLines(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = FENCE_LINE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return line.replace(NON_HEADING_HASH, "$1\\$2");
    })
    .join("\n");
}

/** `replyFirst` sends the first chunk as a native reply; later chunks are plain posts. */
async function postChunks(
  adapter: string,
  target: PostTarget,
  parts: readonly string[],
  replyFirst?: (message: { markdown: string }) => Promise<SentChunk>,
): Promise<{ messageIds: string[]; threadId?: string }> {
  const messageIds: string[] = [];
  let threadId: string | undefined;
  const limit = chatMessageLimit(adapter);
  for (const chunk of parts.flatMap((part) => splitChatMessage(part, limit))) {
    const message = { markdown: adapter === "telegram" ? escapeTelegramHashLines(chunk) : chunk };
    const sent =
      replyFirst && messageIds.length === 0
        ? await replyFirst(message)
        : await target.post(message);
    messageIds.push(sent.id);
    threadId ??= sent.threadId;
  }
  return { messageIds, threadId };
}

type LoadedFile = { name: string; mimeType: string; data: Buffer };

/** First usable MIME type, else a guess from the file extension. */
function resolveMimeType(name: string, ...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const type = candidate?.split(";")[0]?.trim().toLowerCase();
    if (type && type !== "application/octet-stream") return type;
  }
  return Bun.file(name).type.split(";")[0] ?? "application/octet-stream";
}

/**
 * How Telegram shows a file. Only types its media methods take are sent as
 * photo, video or audio; everything else, and a photo over 10 MB, goes as a
 * document.
 */
export function telegramAttachmentType(mimeType: string, sizeBytes: number): Attachment["type"] {
  if (
    (mimeType === "image/jpeg" || mimeType === "image/png") &&
    sizeBytes <= TELEGRAM_PHOTO_LIMIT
  ) {
    return "image";
  }
  if (mimeType === "video/mp4") return "video";
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp4" || mimeType === "audio/x-m4a") {
    return "audio";
  }
  return "file";
}

/**
 * Telegram media groups mix photos and videos only; documents and audio group
 * with their own kind. Other adapters put any files in one message.
 */
function fileGroupKey(adapter: string, file: LoadedFile): string {
  if (adapter !== "telegram") return "files";
  const type = telegramAttachmentType(file.mimeType, file.data.byteLength);
  return type === "image" || type === "video" ? "visual" : type;
}

function fileMessage(adapter: string, files: LoadedFile[]) {
  // Telegram uploads `files` only as documents; typed `attachments` become
  // photos, videos and audio. A list of 2 to 10 is sent as one media group.
  if (adapter === "telegram") {
    return {
      markdown: "",
      attachments: files.map(
        (file): Attachment => ({
          type: telegramAttachmentType(file.mimeType, file.data.byteLength),
          name: file.name,
          mimeType: file.mimeType,
          size: file.data.byteLength,
          data: file.data,
        }),
      ),
    };
  }
  return {
    markdown: "",
    files: files.map((file) => ({ data: file.data, filename: file.name, mimeType: file.mimeType })),
  };
}

function platformName(adapter: string): string {
  return adapter.charAt(0).toUpperCase() + adapter.slice(1);
}

/**
 * Send files as file messages, up to 10 per message, grouped the way the
 * platform allows. Files are read one by one and a group is sent once full, so
 * at most one group is held in memory. Never throws: a file that is too large,
 * cannot be read, or is refused by the platform lands in `unsent`.
 */
async function postFiles(
  adapter: string,
  target: PostTarget,
  files: OutboundChatFile[],
): Promise<{ messageIds: string[]; unsent: UnsentChatFile[] }> {
  const limit = chatUploadLimit(adapter);
  const tooLarge = (size: number) =>
    `${formatFileSize(size)}, over the ${formatFileSize(limit)} upload limit of ${platformName(adapter)}`;
  const messageIds: string[] = [];
  const unsent: UnsentChatFile[] = [];
  const groups = new Map<string, LoadedFile[]>();

  const send = async (group: LoadedFile[]) => {
    try {
      const sent = await target.post(fileMessage(adapter, group));
      messageIds.push(sent.id);
    } catch (error) {
      const reason = `refused by ${platformName(adapter)} (${scrubSecrets(errorMessage(error))})`;
      for (const file of group) unsent.push({ name: file.name, reason });
    }
  };

  for (const file of files) {
    if (file.sizeBytes !== undefined && file.sizeBytes > limit) {
      unsent.push({ name: file.name, reason: tooLarge(file.sizeBytes) });
      continue;
    }
    let loaded: LoadedFile;
    try {
      const { data, mimeType } = await file.load(limit);
      if (data.byteLength > limit) throw new ChatFileTooLargeError(data.byteLength);
      loaded = {
        name: file.name,
        mimeType: resolveMimeType(file.name, file.mimeType, mimeType),
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      };
    } catch (error) {
      unsent.push({
        name: file.name,
        reason:
          error instanceof ChatFileTooLargeError
            ? tooLarge(error.sizeBytes)
            : `could not be read (${scrubSecrets(errorMessage(error))})`,
      });
      continue;
    }
    const key = fileGroupKey(adapter, loaded);
    const group = [...(groups.get(key) ?? []), loaded];
    if (group.length === CHAT_FILES_PER_MESSAGE) {
      groups.delete(key);
      await send(group);
    } else {
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) await send(group);
  return { messageIds, unsent };
}

/** Tool-result suffix naming the files that did not go out; empty when all did. */
export function unsentFilesSummary(unsent: UnsentChatFile[]): string {
  return unsent.length === 0 ? "" : ` ${formatUnsentFilesNote(unsent)}`;
}

/** One line of untrusted text: control characters and line breaks become spaces. */
function singleLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
}

/** A zero-width space after `@` and `<!` keeps adapters from turning text into mentions. */
function breakMentions(text: string): string {
  return text.replace(/@/g, "@\u200b").replace(/<!/g, "<\u200b!");
}

/**
 * A file name as a Markdown code span, so it renders literally: no emphasis,
 * links, or mentions. The fence is one backtick longer than the longest run
 * inside, and the padding keeps an edge backtick from joining the fence.
 */
function codeSpan(text: string): string {
  const value = breakMentions(singleLine(text)) || "(unnamed)";
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * The note posted after the files when some did not go out. File names come
 * from senders and agents, so they render as code spans and cannot add
 * formatting or mentions to the bot's message.
 */
export function formatUnsentFilesNote(unsent: UnsentChatFile[]): string {
  const lines = unsent.map(
    (file) => `- ${codeSpan(file.name)}: ${breakMentions(singleLine(file.reason))}`,
  );
  const count = unsent.length === 1 ? "1 file" : `${unsent.length} files`;
  return [`Could not send ${count}:`, ...lines].join("\n");
}

/**
 * Post markdown to a Chat SDK thread or channel. Scrubs the text, splits it by
 * the adapter limit, and emits one `chat.message.sent` for the whole message
 * once every chunk was accepted. `files` go out after the text; a file that
 * does not reach the thread is named in a note there and in `unsentFiles`,
 * and does not fail the call. Throws `ChatAdapterUnavailableError` when the
 * adapter is not running, `UntrustedTeamsServiceUrlError` before any send
 * when a Teams id points at a host that is not Bot Framework, and the adapter
 * error when a send fails.
 *
 * Delivery is at-least-once: a chunk failure re-posts earlier chunks on retry,
 * and a crash between the send and `markChatRelayDelivered` re-sends the
 * message.
 *
 * An array `text` is posted as one message per element, each still split at
 * the limit; the caller uses it when its own markup must not be cut in two.
 *
 * `replyToMessageId` anchors the first chunk to that message on a thread
 * target. Telegram sends it with `allow_sending_without_reply`, so a deleted
 * target still gets the message, unthreaded.
 */
export async function postChatMessage(args: {
  adapter: string;
  threadId?: string;
  channelId?: string;
  text: string | readonly string[];
  taskId?: string;
  files?: OutboundChatFile[];
  replyToMessageId?: string;
}): Promise<ChatPostResult> {
  // Ids come from tools and stored context keys. Check the Teams origin
  // before the adapter sends its token.
  assertTrustedChatTarget(args.threadId ?? args.channelId ?? "");
  const chat = getChatInstance(args.adapter);
  if (!chat) throw new ChatAdapterUnavailableError(args.adapter);
  const parts = (typeof args.text === "string" ? [args.text] : args.text).map(scrubSecrets);
  const text = parts.join("\n\n");

  let result: ChatPostResult;
  let target: PostTarget;
  if (args.threadId) {
    const thread = chat.thread(args.threadId);
    target = thread;
    // Only adapters with a native reply (Telegram in this SDK version) anchor;
    // the others post unanchored, as before.
    const replyTo = args.replyToMessageId;
    const sent = await postChunks(
      args.adapter,
      thread,
      parts,
      replyTo && thread.adapter.reply ? (message) => thread.reply(replyTo, message) : undefined,
    );
    result = {
      adapter: args.adapter,
      threadId: thread.id,
      channelId: thread.channelId,
      messageIds: sent.messageIds,
      unsentFiles: [],
    };
  } else if (args.channelId) {
    const channel = chat.channel(args.channelId);
    target = channel;
    const sent = await postChunks(args.adapter, channel, parts);
    result = {
      adapter: args.adapter,
      threadId: sent.threadId ?? channel.id,
      channelId: channel.id,
      messageIds: sent.messageIds,
      unsentFiles: [],
    };
  } else {
    throw new Error("postChatMessage needs a threadId or a channelId");
  }

  if (args.files?.length) {
    const sent = await postFiles(args.adapter, target, args.files);
    result.messageIds.push(...sent.messageIds);
    result.unsentFiles = sent.unsent;
    if (sent.unsent.length > 0) {
      const note = formatUnsentFilesNote(sent.unsent);
      const noted = await postChunks(args.adapter, target, [scrubSecrets(note)]);
      result.messageIds.push(...noted.messageIds);
    }
  }

  emitChatMessageSent({
    adapter: result.adapter,
    channelId: result.channelId,
    threadId: result.threadId,
    text,
    taskId: args.taskId,
    messageId: result.messageIds.at(-1),
  });
  return result;
}
