/**
 * Slack files turned into task attachments: the ones a user shares with the
 * bot, and the ones an agent fetches with `slack-download-file` / `slack-read`.
 *
 * The API downloads each file with the bot token, stores it through the active
 * file provider and records a `task_attachments` row, so the worker gets the
 * same fetch recipe as a file uploaded from the UI. The task is created in
 * `draft` while that happens (#1240): nobody can claim it before its
 * attachments exist. Every file also stays in the task text as a
 * `[File: …]` line, and the user gets a thread reply naming any file that
 * could not be attached — never dropped silently. A download failure is
 * also flagged on that line; a storage failure happens after the text is
 * written, so it shows up only in the reply and in the missing attachment.
 */
import type { WebClient } from "@slack/web-api";
import { getTaskAttachments, getTaskById, promoteDraftTask } from "../be/db";
import { MAX_TASK_ATTACHMENT_BYTES, recordTaskAttachmentUpload } from "../be/task-attachment-store";
import { providerPath } from "../fs/provider";
import { getFileStorageProvider } from "../fs/registry";
import { resolveTemplate } from "../prompts/resolver";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import type { AgentTask, CreateTaskOptions, TaskAttachment } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { taskAttachmentFetchCommand } from "../utils/task-attachment-links";
import { getFileInfo, type SlackFile } from "./files";
// Side-effect import: registers all Slack event templates in the in-memory registry
import "./templates";

const DOWNLOAD_TIMEOUT_MS = 30_000;
/** A file a user sent the bot, like one uploaded from the dashboard composer. */
const SHARED_FILE_INTENT = "user-upload";
/** A file an agent pulled from Slack with `slack-download-file` / `slack-read`. */
const FETCHED_FILE_INTENT = "slack-file";
const BUFFERED_REASON = "follow-ups queued by ADDITIVE_SLACK carry the file name only";

export type SlackFileFailure = { file: SlackFile; reason: string };

export type AttachedSlackFile = { file: SlackFile; attachment: TaskAttachment };

/** What happened to one file an agent asked to attach: the attachment and how to fetch it, or why not. */
export type SlackFileOutcome =
  | { attachment: TaskAttachment; fetchCommand: string }
  | { reason: string };

export type InboundSlackFiles = {
  /** Every file on the message, with full metadata (resolved via `files.info` when the event omitted it). */
  files: SlackFile[];
  fetched: Array<{ file: SlackFile; body: Uint8Array }>;
  failed: SlackFileFailure[];
};

/** Error text safe to put in a task or a Slack message. */
function errorText(error: unknown): string {
  return scrubSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Build a text representation of file attachments for inclusion in messages.
 * Each file is formatted as: [File: filename.ext (mimetype, size) id=FILE_ID],
 * followed by `(not attached: <reason>)` when the file never made it into the
 * task's attachments.
 */
export function buildAttachmentText(files: SlackFile[], failed: SlackFileFailure[] = []): string {
  const reasons = new Map(failed.map((f) => [f.file.id, f.reason]));
  return files
    .map((f) => {
      // A file only `files.info` could describe may still lack metadata.
      const size = typeof f.size === "number" ? formatFileSize(f.size) : "unknown size";
      const line = `[File: ${f.name ?? f.id} (${f.mimetype ?? "unknown type"}, ${size}) id=${f.id}]`;
      const reason = reasons.get(f.id);
      return reason ? `${line} (not attached: ${reason})` : line;
    })
    .join("\n");
}

/**
 * Build the effective message text from the original text and any file attachments.
 * - Text only: returns the text as-is
 * - Files only: returns the attachment metadata
 * - Both: returns text followed by attachment metadata
 */
export function buildEffectiveText(
  text: string | undefined,
  files?: SlackFile[],
  failed?: SlackFileFailure[],
): string {
  const hasText = !!text?.trim();
  const hasFiles = files && files.length > 0;

  if (hasText && hasFiles) {
    return `${text}\n\n${buildAttachmentText(files, failed)}`;
  }
  if (hasFiles) {
    return buildAttachmentText(files, failed);
  }
  return text || "";
}

/**
 * The files of a follow-up that `ADDITIVE_SLACK` queues instead of turning into
 * a task right away: the queued text keeps their `[File: …]` lines, but they
 * are not attached, so they're reported like any other unattached file.
 */
export function bufferedFileFailures(files: SlackFile[] | undefined): SlackFileFailure[] {
  return (files ?? []).map((file) => ({ file, reason: BUFFERED_REASON }));
}

/**
 * Download every file on a Slack message with the bot token. Never throws: a
 * file that can't be fetched lands in `failed` with a reason the user and the
 * agent can read.
 */
export async function fetchSlackFiles(
  client: WebClient,
  files: SlackFile[] | undefined,
): Promise<InboundSlackFiles> {
  const result: InboundSlackFiles = { files: [], fetched: [], failed: [] };
  if (!files || files.length === 0) return result;

  const token = client.token ?? process.env.SLACK_BOT_TOKEN;
  for (const eventFile of files) {
    // Slack Connect and some file_share events carry only the file id.
    const file = eventFile.url_private_download
      ? eventFile
      : ((await getFileInfo(client, eventFile.id)) ?? eventFile);
    result.files.push(file);

    const outcome = await downloadSlackFile(file, token);
    if (typeof outcome === "string") {
      console.warn(`[Slack] could not fetch file ${file.id}: ${outcome}`);
      result.failed.push({ file, reason: outcome });
    } else {
      result.fetched.push({ file, body: outcome });
    }
  }
  return result;
}

/** The file's bytes, or the reason they couldn't be fetched. */
async function downloadSlackFile(
  file: SlackFile,
  token: string | undefined,
): Promise<Uint8Array | string> {
  const limit = `larger than the ${MAX_TASK_ATTACHMENT_BYTES / (1024 * 1024)} MB limit`;
  if (file.size > MAX_TASK_ATTACHMENT_BYTES) return limit;
  if (!file.url_private_download) return "Slack gave no download URL";
  if (!token) return "no Slack bot token configured";

  try {
    const response = await fetch(file.url_private_download, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return `download failed (HTTP ${response.status})`;
    // Without `files:read` Slack answers 200 with its HTML sign-in page.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.startsWith("text/html") && !file.mimetype?.startsWith("text/html")) {
      return "Slack returned its sign-in page instead of the file (is the files:read scope granted?)";
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_TASK_ATTACHMENT_BYTES) return limit;
    return body;
  } catch (error) {
    return `download failed (${errorText(error)})`;
  }
}

/**
 * Create a Slack-sourced task and attach the files fetched from its message.
 * With files, the task is created in `draft` and promoted once every upload
 * has settled — success or not — so a worker can't start before its
 * attachments exist. `unattached` lists every file of the message that the
 * task ended up without: the ones that couldn't be downloaded plus the ones
 * that couldn't be stored.
 */
export async function createSlackTaskWithFiles(
  description: string,
  options: CreateTaskOptions,
  inbound: InboundSlackFiles,
): Promise<{ task: AgentTask; unattached: SlackFileFailure[] }> {
  if (inbound.fetched.length === 0) {
    const task = await createTaskWithSiblingAwareness(description, options);
    return { task, unattached: inbound.failed };
  }

  const task = await createTaskWithSiblingAwareness(description, { ...options, status: "draft" });
  const unattached = [...inbound.failed];
  try {
    unattached.push(...(await attachSlackFilesToTask(task.id, inbound.fetched, null)).unattached);
  } finally {
    await promoteDraftTask(task.id);
  }
  return { task, unattached };
}

/**
 * Store fetched Slack files as attachments of a task. `agentId` is the agent
 * that fetched them, or `null` for files a user sent the bot.
 *
 * A file whose bytes the task already holds is reused instead of uploaded
 * again. Each blob is keyed by its Slack file id, so two different files can
 * never overwrite each other's bytes — not even from parallel tool calls.
 * The attachment name stays the file's own, and gets the Slack file id as a
 * prefix only when another attachment already uses it (pasted screenshots are
 * all called "image.png"), so fetch commands don't collide in `/tmp` either.
 */
export async function attachSlackFilesToTask(
  taskId: string,
  fetched: InboundSlackFiles["fetched"],
  agentId: string | null,
): Promise<{ attached: AttachedSlackFile[]; unattached: SlackFileFailure[] }> {
  const existing = await getTaskAttachments(taskId);
  const bySha = new Map(existing.flatMap((a) => (a.sha256 ? [[a.sha256, a] as const] : [])));
  const usedNames = new Set(existing.map((a) => a.name));
  const provider = getFileStorageProvider();
  const attached: AttachedSlackFile[] = [];
  const unattached: SlackFileFailure[] = [];

  for (const { file, body } of fetched) {
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const known = bySha.get(sha256);
    if (known) {
      attached.push({ file, attachment: known });
      continue;
    }
    const name = usedNames.has(file.name) ? `${file.id}-${file.name}` : file.name;
    usedNames.add(name);
    const key = providerPath({ taskId, name: `slack-${file.id}-${file.name}` });
    const scope = { taskId, name, key };
    try {
      const uploaded = await provider.upload(scope, body, {
        contentType: file.mimetype,
        sizeBytes: body.byteLength,
        message: `Upload ${name} from Slack for task ${taskId}`,
      });
      const attachment = await recordTaskAttachmentUpload({
        provider,
        scope,
        uploaded: { ...uploaded, sha256: uploaded.sha256 ?? sha256 },
        body,
        contentType: file.mimetype,
        agentId,
        intent: agentId ? FETCHED_FILE_INTENT : SHARED_FILE_INTENT,
        description: agentId
          ? `Fetched from Slack (file ${file.id})`
          : `Shared on Slack (file ${file.id})`,
      });
      bySha.set(sha256, attachment);
      attached.push({ file, attachment });
    } catch (error) {
      const reason = `could not be stored (${errorText(error)})`;
      console.warn(`[Slack] file ${file.id} for task ${taskId} ${reason}`);
      unattached.push({ file, reason });
    }
  }
  return { attached, unattached };
}

/**
 * Download Slack files and attach them to `task` on behalf of `agentId`
 * (`slack-download-file`, `slack-read`). One outcome per Slack file id.
 */
export async function attachSlackFilesForAgent(
  client: WebClient,
  task: AgentTask,
  files: SlackFile[],
  agentId: string,
): Promise<Map<string, SlackFileOutcome>> {
  const inbound = await fetchSlackFiles(client, files);
  const { attached, unattached } = await attachSlackFilesToTask(task.id, inbound.fetched, agentId);
  const outcomes = new Map<string, SlackFileOutcome>();
  for (const { file, reason } of [...inbound.failed, ...unattached]) {
    outcomes.set(file.id, { reason });
  }
  for (const { file, attachment } of attached) {
    outcomes.set(file.id, {
      attachment,
      fetchCommand: taskAttachmentFetchCommand(task.id, attachment.id, attachment.name),
    });
  }
  return outcomes;
}

/**
 * The task a Slack file tool may attach files to: `taskId` if the calling
 * agent owns or created it, `null` otherwise (or when there is no task).
 */
export async function attachableTask(
  agentId: string,
  taskId: string | undefined,
): Promise<AgentTask | null> {
  if (!taskId) return null;
  const task = await getTaskById(taskId);
  if (!task) return null;
  return task.agentId === agentId || task.creatorAgentId === agentId ? task : null;
}

/**
 * Tell the user, in the thread, which of their files the agent won't see —
 * one reply listing each file once, even when several tasks failed on it.
 * Best-effort: a failed post is logged, never thrown.
 */
export async function notifySlackFileFailures(
  client: WebClient,
  channel: string,
  threadTs: string,
  failures: SlackFileFailure[],
): Promise<void> {
  if (failures.length === 0) return;
  const byFile = new Map(failures.map((f) => [f.file.id, f]));
  const failedFiles = [...byFile.values()]
    .map((f) => `\`${f.file.name}\` (${f.reason})`)
    .join(", ");
  const { text } = resolveTemplate("slack.message.attachment_failed", {
    failed_files: failedFiles,
  });
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    console.warn(
      `[Slack] could not post the attachment-failure notice in ${channel}/${threadTs}: ${errorText(error)}`,
    );
  }
}
