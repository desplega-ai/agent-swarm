/**
 * "Send to swarm": turn agent-fs comments into ONE task for the lead.
 *
 * The browser sends only comment ids. The server reads each comment again
 * from agent-fs with the bootstrap key, claims it in KV (idempotent and safe
 * under races), creates the task from the `comb.review.*` templates, and
 * replies `[comb:sent task=<id>] ...` on each comment as the swarm service
 * account.
 */

import { claimKv, deleteKv, getDbClient, getKv, getLeadAgent, upsertKv } from "../be/db";
import { findUserById } from "../be/users";
import {
  type AgentFsComment,
  type AgentFsCommentThread,
  type AgentFsDrive,
  type AgentFsFileVersion,
  type AgentFsProvider,
  agentFsRequestTimeoutMs,
} from "../fs/agent-fs-provider";
import { FilesError } from "../fs/provider";
import { resolveTemplate } from "../prompts/resolver";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import type { KvEntry } from "../types";
import { agentFsFileRoute, getAppUrl } from "../utils/constants";
import { scrubSecrets } from "../utils/secret-scrubber";
import { combAgentFs } from "./agent-fs";
import { getCombConfig } from "./config";
import { sentMarker, sentTaskId } from "./markers";
// Side-effect import: registers the comb.review.* templates.
import "./templates";

/** Most comments one batch may carry. */
export const REVIEW_BATCH_MAX = 50;

export const SENT_KV_NAMESPACE = "comb:sent";
// A claim that never reaches "sent" (the process died mid-send) frees itself.
const PENDING_CLAIM_MS = 5 * 60_000;
const SENT_CLAIM_MS = 30 * 24 * 60 * 60_000;
// Slack on top of one agent-fs request deadline (see `replyWindowMs`).
const REPLY_MARGIN_MS = 5_000;

export type SkipReason = "not-found" | "reply" | "resolved" | "already-sent";

export interface SkippedComment {
  id: string;
  reason: SkipReason;
  /** The task an "already-sent" comment went to, when known. */
  taskId?: string;
}

/** A comment of an earlier send whose missing "sent" reply this batch posted. */
export interface RepairedComment {
  id: string;
  taskId: string;
}

export interface ReviewBatchInput {
  orgId: string;
  driveId: string;
  commentIds: string[];
  /** The file or folder the batch was sent from. */
  scopePath: string;
  requestedByUserId: string | null;
}

export interface ReviewBatchResult {
  /** The new task. Null when the batch only repaired replies of earlier sends. */
  taskId: string | null;
  sent: string[];
  skipped: SkippedComment[];
  repaired: RepairedComment[];
}

export interface ReviewBatchDeps {
  createTask: typeof createTaskWithSiblingAwareness;
}

/** A batch that cannot run. The route answers with `status`. */
export class ReviewBatchError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    message: string,
    readonly skipped: SkippedComment[] = [],
  ) {
    super(message);
    this.name = "ReviewBatchError";
  }
}

/** One requested comment as agent-fs answered it. */
interface CommentRead {
  id: string;
  thread: AgentFsCommentThread | null;
  /** The file version the comment was made on, when known. */
  version?: number;
}

export async function sendReviewBatch(
  input: ReviewBatchInput,
  deps: Partial<ReviewBatchDeps> = {},
): Promise<ReviewBatchResult> {
  const comb = getCombConfig();
  if (!comb.enabled) throw new ReviewBatchError(404, "Comb is not enabled");
  if (!comb.orgId || !comb.driveId) {
    throw new ReviewBatchError(503, "The swarm has no agent-fs drive yet");
  }
  if (input.orgId !== comb.orgId || input.driveId !== comb.driveId) {
    throw new ReviewBatchError(400, "Comb sends comments from the swarm drive only");
  }
  const ids = [...new Set(input.commentIds)];
  if (ids.length === 0 || ids.length > REVIEW_BATCH_MAX) {
    throw new ReviewBatchError(400, `Send between 1 and ${REVIEW_BATCH_MAX} comments`);
  }
  const agentFs = combAgentFs();
  if (!agentFs) throw new ReviewBatchError(503, "agent-fs is not set up for this swarm");
  const drive: AgentFsDrive = { orgId: input.orgId, driveId: input.driveId };
  const createTask = deps.createTask ?? createTaskWithSiblingAwareness;

  // 1. Every agent-fs read runs now, in parallel, before any claim. The
  //    browser's copy is not trusted. Only DB work runs while this send holds
  //    pending claims, so a pending claim cannot expire mid-send.
  const readStartedAt = Date.now();
  const versionOf = fileVersionLookup(agentFs, drive);
  const [serviceUserId, reads] = await Promise.all([
    agentFs.getServiceUserId().catch(() => null),
    Promise.all(ids.map((id) => readComment(agentFs, drive, versionOf, id))),
  ]);
  const skipped: SkippedComment[] = [];
  const candidates: CommentRead[] = [];
  for (const read of reads) {
    const skip = skipOf(read, serviceUserId);
    if (skip) skipped.push(skip);
    else candidates.push(read);
  }

  // 2. Claim in one transaction, so two sends never split one set of comments.
  const claim = crypto.randomUUID();
  const { won, lost } = await claimComments(candidates, claim);

  // 3. A claim lost to a finished send, on a thread without the "sent" reply,
  //    means that send's reply failed. This send posts it again (step 5).
  const repairs: RepairedComment[] = [];
  for (const { id, entry } of lost) {
    const taskId = sentClaimTaskId(entry);
    if (taskId && entry && entry.updatedAt + replyWindowMs() < readStartedAt) {
      repairs.push({ id, taskId });
    } else {
      skipped.push(alreadySent(id, taskId));
    }
  }

  // 4. One task for the won comments. On failure, free the claims again.
  const wonIds = won.map((read) => read.id);
  let taskId: string | null = null;
  if (won.length > 0) {
    try {
      const text = await renderTaskText(input, won);
      if (text === null) {
        throw new ReviewBatchError(503, "The Comb review template is disabled", [
          ...skipped,
          ...repairs.map((repair) => alreadySent(repair.id, repair.taskId)),
        ]);
      }
      const lead = await getLeadAgent();
      const task = await createTask(
        text,
        {
          agentId: lead?.id ?? "",
          routingReason: lead ? "skill" : undefined,
          routingSource: lead ? "engine_default" : undefined,
          source: "comb",
          taskType: "comb-review",
          tags: ["comb"],
          requestedByUserId: input.requestedByUserId ?? undefined,
        },
        { origin: "rest" },
      );
      taskId = task.id;
    } catch (error) {
      await settleClaims(wonIds, claim, null);
      throw error;
    }
    // The task exists: a failure to record it is logged, not thrown.
    await settleClaims(wonIds, claim, { status: "sent", taskId });
  }

  // 5. The "sent" replies, new and repaired. A failed new reply does not fail
  //    the call: the KV row blocks a second task, and a later send repairs it.
  const targets: RepairedComment[] = [
    ...wonIds.map((id) => ({ id, taskId: taskId as string })),
    ...repairs,
  ];
  const replies = await Promise.allSettled(
    targets.map((target) => agentFs.replyToComment(drive, target.id, sentReply(target.taskId))),
  );
  const repaired: RepairedComment[] = [];
  replies.forEach((reply, index) => {
    const target = targets[index] as RepairedComment;
    const isRepair = index >= wonIds.length;
    if (reply.status === "rejected") {
      console.warn(
        scrubSecrets(
          `[comb] sent reply failed comment=${target.id} task=${target.taskId}: ${errorMessage(reply.reason)}`,
        ),
      );
      if (isRepair) skipped.push(alreadySent(target.id, target.taskId));
    } else if (isRepair) {
      repaired.push(target);
    }
  });

  if (taskId === null && repaired.length === 0) {
    throw new ReviewBatchError(409, "Nothing to send", skipped);
  }
  return { taskId, sent: wonIds, skipped, repaired };
}

async function readComment(
  agentFs: AgentFsProvider,
  drive: AgentFsDrive,
  versionOf: (comment: AgentFsComment) => Promise<number | undefined>,
  id: string,
): Promise<CommentRead> {
  let thread: AgentFsCommentThread;
  try {
    thread = await agentFs.getComment(drive, id);
  } catch (error) {
    if (error instanceof FilesError && error.code === "NotFound") return { id, thread: null };
    throw new ReviewBatchError(
      502,
      scrubSecrets(`agent-fs could not read comment ${id}: ${errorMessage(error)}`),
    );
  }
  const { comment } = thread;
  const version = comment.fileVersion ?? (comment.parentId ? undefined : await versionOf(comment));
  return { id, thread, version };
}

function skipOf({ id, thread }: CommentRead, serviceUserId: string | null): SkippedComment | null {
  if (!thread) return { id, reason: "not-found" };
  if (thread.comment.parentId) return { id, reason: "reply" };
  if (thread.comment.resolved) return { id, reason: "resolved" };
  const taskId = sentTaskId(thread.comment, thread.replies, serviceUserId);
  return taskId ? alreadySent(id, taskId) : null;
}

function alreadySent(id: string, taskId: string | null | undefined): SkippedComment {
  return taskId ? { id, reason: "already-sent", taskId } : { id, reason: "already-sent" };
}

/**
 * Claim each candidate with a pending row that carries this send's `claim`
 * token. A lost claim comes back with the row that holds it.
 */
async function claimComments(
  candidates: CommentRead[],
  claim: string,
): Promise<{ won: CommentRead[]; lost: Array<{ id: string; entry: KvEntry | null }> }> {
  return await getDbClient().transaction(async () => {
    const won: CommentRead[] = [];
    const lost: Array<{ id: string; entry: KvEntry | null }> = [];
    for (const read of candidates) {
      const claimed = await claimKv({
        namespace: SENT_KV_NAMESPACE,
        key: read.id,
        value: { status: "pending", claim },
        valueType: "json",
        expiresAt: Date.now() + PENDING_CLAIM_MS,
      });
      if (claimed) won.push(read);
      else lost.push({ id: read.id, entry: await getKv(SENT_KV_NAMESPACE, read.id) });
    }
    return { won, lost };
  });
}

/**
 * Release this send's claims (`next` null) or record them as sent. A row that
 * another send claimed after this claim expired stays as it is. Failures are
 * logged, never thrown: the caller is already returning a result or an error.
 */
async function settleClaims(
  ids: string[],
  claim: string,
  next: { status: "sent"; taskId: string } | null,
): Promise<void> {
  const settled = await Promise.allSettled(
    ids.map((id) =>
      getDbClient().transaction(async () => {
        const entry = await getKv(SENT_KV_NAMESPACE, id);
        if (entry && claimToken(entry) !== claim) return false;
        if (next) {
          await upsertKv({
            namespace: SENT_KV_NAMESPACE,
            key: id,
            value: next,
            valueType: "json",
            expiresAt: Date.now() + SENT_CLAIM_MS,
          });
        } else if (entry) {
          await deleteKv(SENT_KV_NAMESPACE, id);
        }
        return true;
      }),
    ),
  );
  settled.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) return;
    const why =
      result.status === "rejected" ? errorMessage(result.reason) : "another send holds the claim";
    console.warn(
      scrubSecrets(
        `[comb] could not ${next ? "record" : "release"} the claim on comment=${ids[index]}: ${why}`,
      ),
    );
  });
}

function claimToken(entry: KvEntry): unknown {
  return (entry.value as { claim?: unknown } | null)?.claim;
}

function sentClaimTaskId(entry: KvEntry | null): string | null {
  const value = entry?.value as { status?: unknown; taskId?: unknown } | null | undefined;
  return value?.status === "sent" && typeof value.taskId === "string" ? value.taskId : null;
}

/**
 * A send writes its "sent" rows, then posts the replies, each within one
 * agent-fs request deadline. A "sent" row older than this when a later send
 * began its reads, on a thread without the reply, means the reply failed.
 */
function replyWindowMs(): number {
  return agentFsRequestTimeoutMs() + REPLY_MARGIN_MS;
}

function sentReply(taskId: string): string {
  return `${sentMarker(taskId)} Sent to the swarm: ${getAppUrl()}/tasks/${taskId}`;
}

/**
 * The file version of a comment that agent-fs left without `fileVersion`: the
 * newest version at or before the comment, as the dashboard does
 * (`versionAt`). agent-fs leaves it out when its lookup misses the file (the
 * stored comment path and the version path differ in form). One `log` per file.
 */
function fileVersionLookup(
  agentFs: AgentFsProvider,
  drive: AgentFsDrive,
): (comment: AgentFsComment) => Promise<number | undefined> {
  const logs = new Map<string, Promise<AgentFsFileVersion[]>>();
  return async (comment) => {
    const path = combPath(comment.path);
    let log = logs.get(path);
    if (!log) {
      // `log` matches the stored version path exactly, and that path comes in
      // either form ("docs/a.md" from the `write` op). Ask for both.
      log = Promise.all(
        [path.slice(1), path].map((form) => agentFs.getFileVersions(drive, form).catch(() => [])),
      ).then((lists) => lists.flat());
      logs.set(path, log);
    }
    const at = Date.parse(comment.createdAt);
    let found: number | undefined;
    for (const entry of await log) {
      if (Date.parse(entry.createdAt) <= at && (found === undefined || entry.version > found)) {
        found = entry.version;
      }
    }
    return found;
  };
}

/** The task text, or null when an operator disabled a `comb.review.*` template. */
async function renderTaskText(
  input: ReviewBatchInput,
  reads: CommentRead[],
): Promise<string | null> {
  const blocks: string[] = [];
  for (const { thread, version } of reads) {
    const comment = (thread as AgentFsCommentThread).comment;
    const path = combPath(comment.path);
    const quote = comment.quote?.exact ?? comment.quotedContent;
    const block = resolveTemplate("comb.review.comment", {
      comment_id: comment.id,
      author: comment.authorDisplayName
        ? `${oneLine(comment.authorDisplayName)} (agent-fs user ${comment.author})`
        : `agent-fs user ${comment.author}`,
      path: oneLine(path),
      file_version: version ?? "unknown",
      line_range: lineRange(comment),
      quote: quote ? fenced(quote) : indent("(none)"),
      body: fenced(comment.body),
      comment_url: combUrl(input, path, comment.id),
    });
    if (block.skipped) return null;
    blocks.push(block.text);
  }
  const scopePath = combPath(input.scopePath);
  const batch = resolveTemplate("comb.review.batch", {
    comment_count: reads.length,
    scope_path: scopePath,
    scope_url: combUrl(input, scopePath),
    requested_by: await requesterLabel(input.requestedByUserId),
    org_id: input.orgId,
    drive_id: input.driveId,
    comments_block: blocks.join("\n"),
  });
  return batch.skipped ? null : batch.text;
}

/** agent-fs stores comment paths with or without the leading "/". Comb shows "/docs/a.md". */
function combPath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

function lineRange(comment: AgentFsComment): string {
  if (comment.lineStart == null) return "whole file";
  const end = comment.lineEnd ?? comment.lineStart;
  return end === comment.lineStart
    ? `line ${comment.lineStart}`
    : `lines ${comment.lineStart}-${end}`;
}

/**
 * Human text as data: an indented fenced block that the text cannot close.
 * The fence is longer than the longest backtick run in the text.
 */
function fenced(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return indent(`${fence}\n${text}\n${fence}`);
}

/** Every line one level under its list item. */
function indent(text: string): string {
  return text.replace(/^/gm, "    ");
}

/** A value that sits inside one prompt line (display names, paths). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The dashboard page for a drive path (`/file/~/<org>/<drive>/<path>`), at one comment if given. */
function combUrl(input: ReviewBatchInput, path: string, commentId?: string): string {
  // A "." or ".." segment has no safe route: link the drive root instead.
  const route =
    agentFsFileRoute({ path, orgId: input.orgId, driveId: input.driveId }) ??
    `${input.orgId}/${input.driveId}/`;
  const url = `${getAppUrl()}/file/~/${route}`;
  return commentId ? `${url}?comment=${encodeURIComponent(commentId)}` : url;
}

async function requesterLabel(userId: string | null): Promise<string> {
  const user = userId ? await findUserById(userId) : null;
  if (!user) return "an operator (swarm API key)";
  return user.email ? `${user.name} <${user.email}>` : user.name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
