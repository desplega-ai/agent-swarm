/**
 * "Send to swarm": turn agent-fs comments into ONE task for the lead.
 *
 * The browser sends only comment ids. The server reads each comment again
 * from agent-fs with the bootstrap key, claims it in KV (idempotent and safe
 * under races), creates the task from the `comb.review.*` templates, and
 * replies `[comb:sent task=<id>] ...` on each comment as the swarm service
 * account.
 */

import { claimKv, deleteKv, getDbClient, getLeadAgent, upsertKv } from "../be/db";
import { findUserById } from "../be/users";
import type {
  AgentFsComment,
  AgentFsCommentThread,
  AgentFsFileVersion,
} from "../fs/agent-fs-provider";
import { FilesError } from "../fs/provider";
import { resolveTemplate } from "../prompts/resolver";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { agentFsFileRoute, getAppUrl } from "../utils/constants";
import { scrubSecrets } from "../utils/secret-scrubber";
import { combAgentFs } from "./agent-fs";
import { getCombConfig } from "./config";
import { isSentToSwarm, sentMarker } from "./markers";
// Side-effect import: registers the comb.review.* templates.
import "./templates";

/** Most comments one batch may carry. */
export const REVIEW_BATCH_MAX = 50;

export const SENT_KV_NAMESPACE = "comb:sent";
// A claim that never reaches "sent" (the process died mid-send) frees itself.
const PENDING_CLAIM_MS = 5 * 60_000;
const SENT_CLAIM_MS = 30 * 24 * 60 * 60_000;

export type SkipReason = "not-found" | "reply" | "resolved" | "already-sent";

export interface SkippedComment {
  id: string;
  reason: SkipReason;
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
  taskId: string;
  sent: string[];
  skipped: SkippedComment[];
}

/** The agent-fs calls a batch needs, all with the bootstrap key. */
export interface CombAgentFs {
  getComment(id: string): Promise<AgentFsCommentThread>;
  getFileVersions(path: string): Promise<AgentFsFileVersion[]>;
  replyToComment(parentId: string, body: string): Promise<unknown>;
  getServiceUserId(): Promise<string>;
}

export interface ReviewBatchDeps {
  agentFs: CombAgentFs;
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

export async function sendReviewBatch(
  input: ReviewBatchInput,
  deps: Partial<ReviewBatchDeps> = {},
): Promise<ReviewBatchResult> {
  const comb = getCombConfig();
  if (!comb.enabled) throw new ReviewBatchError(404, "Comb is not enabled");
  if (!comb.orgId || input.orgId !== comb.orgId || input.driveId !== comb.driveId) {
    throw new ReviewBatchError(400, "Comb sends comments from the swarm drive only");
  }
  const ids = [...new Set(input.commentIds)];
  if (ids.length === 0 || ids.length > REVIEW_BATCH_MAX) {
    throw new ReviewBatchError(400, `Send between 1 and ${REVIEW_BATCH_MAX} comments`);
  }
  const agentFs = deps.agentFs ?? combAgentFs();
  if (!agentFs) throw new ReviewBatchError(503, "agent-fs is not set up for this swarm");
  const createTask = deps.createTask ?? createTaskWithSiblingAwareness;

  // 1. Read every comment again. The browser's copy is not trusted.
  const serviceUserId = await agentFs.getServiceUserId().catch(() => null);
  const threads = await Promise.all(ids.map((id) => readComment(agentFs, id)));
  const skipped: SkippedComment[] = [];
  const candidates: AgentFsComment[] = [];
  threads.forEach((thread, index) => {
    const id = ids[index] as string;
    const reason = skipReason(thread, serviceUserId);
    if (reason) skipped.push({ id, reason });
    else candidates.push((thread as AgentFsCommentThread).comment);
  });

  // 2. Claim in one transaction, so two sends never split one set of comments.
  const now = Date.now();
  const comments = await getDbClient().transaction(async () => {
    const won: AgentFsComment[] = [];
    for (const comment of candidates) {
      const claimed = await claimKv({
        namespace: SENT_KV_NAMESPACE,
        key: comment.id,
        value: { status: "pending" },
        valueType: "json",
        expiresAt: now + PENDING_CLAIM_MS,
      });
      if (claimed) won.push(comment);
      else skipped.push({ id: comment.id, reason: "already-sent" });
    }
    return won;
  });
  if (comments.length === 0) {
    throw new ReviewBatchError(409, "Nothing to send", skipped);
  }

  let taskId: string;
  try {
    const versions = await commentVersions(agentFs, comments);
    const text = await renderTaskText(input, comments, versions);
    if (text === null) throw new ReviewBatchError(409, "The Comb review template is disabled");
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
    await Promise.all(comments.map((comment) => deleteKv(SENT_KV_NAMESPACE, comment.id)));
    throw error;
  }

  // 3. Record the send. The KV row blocks a second send even when a reply fails.
  await Promise.all(
    comments.map((comment) =>
      upsertKv({
        namespace: SENT_KV_NAMESPACE,
        key: comment.id,
        value: { status: "sent", taskId },
        valueType: "json",
        expiresAt: Date.now() + SENT_CLAIM_MS,
      }),
    ),
  );
  const replyBody = `${sentMarker(taskId)} Sent to the swarm: ${getAppUrl()}/tasks/${taskId}`;
  const replies = await Promise.allSettled(
    comments.map((comment) => agentFs.replyToComment(comment.id, replyBody)),
  );
  replies.forEach((reply, index) => {
    if (reply.status === "fulfilled") return;
    const message = reply.reason instanceof Error ? reply.reason.message : String(reply.reason);
    console.warn(
      scrubSecrets(
        `[comb] sent reply failed comment=${comments[index]?.id} task=${taskId}: ${message}`,
      ),
    );
  });

  return { taskId, sent: comments.map((comment) => comment.id), skipped };
}

async function readComment(agentFs: CombAgentFs, id: string): Promise<AgentFsCommentThread | null> {
  try {
    return await agentFs.getComment(id);
  } catch (error) {
    if (error instanceof FilesError && error.code === "NotFound") return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new ReviewBatchError(
      502,
      scrubSecrets(`agent-fs could not read comment ${id}: ${message}`),
    );
  }
}

function skipReason(
  thread: AgentFsCommentThread | null,
  serviceUserId: string | null,
): SkipReason | null {
  if (!thread) return "not-found";
  if (thread.comment.parentId) return "reply";
  if (thread.comment.resolved) return "resolved";
  if (isSentToSwarm(thread.comment, thread.replies, serviceUserId)) return "already-sent";
  return null;
}

/**
 * The file version of each comment. agent-fs leaves `fileVersion` out when
 * its lookup misses the file (the stored comment path and the version path
 * differ in form). Then the file's `log` answers: the newest version at or
 * before the comment, as the dashboard does (`versionAt`).
 */
async function commentVersions(
  agentFs: CombAgentFs,
  comments: AgentFsComment[],
): Promise<Map<string, number>> {
  const versions = new Map<string, number>();
  const logs = new Map<string, Promise<AgentFsFileVersion[]>>();
  for (const comment of comments) {
    if (comment.fileVersion !== undefined) {
      versions.set(comment.id, comment.fileVersion);
      continue;
    }
    const path = combPath(comment.path);
    let log = logs.get(path);
    if (!log) {
      // `log` matches the stored version path exactly, and that path comes in
      // either form ("docs/a.md" from the `write` op). Ask for both.
      log = Promise.all(
        [path.slice(1), path].map((form) => agentFs.getFileVersions(form).catch(() => [])),
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
    if (found !== undefined) versions.set(comment.id, found);
  }
  return versions;
}

/** The task text, or null when an operator disabled a `comb.review.*` template. */
async function renderTaskText(
  input: ReviewBatchInput,
  comments: AgentFsComment[],
  versions: Map<string, number>,
): Promise<string | null> {
  const blocks: string[] = [];
  for (const comment of comments) {
    const path = combPath(comment.path);
    const block = resolveTemplate("comb.review.comment", {
      comment_id: comment.id,
      author: comment.authorDisplayName
        ? `${comment.authorDisplayName} (agent-fs user ${comment.author})`
        : `agent-fs user ${comment.author}`,
      path,
      file_version: versions.get(comment.id) ?? "unknown",
      line_range: lineRange(comment),
      quote: indent(comment.quote?.exact ?? comment.quotedContent ?? "(none)"),
      body: indent(comment.body),
      comment_url: combUrl(input, path, comment.id),
    });
    if (block.skipped) return null;
    blocks.push(block.text);
  }
  const scopePath = combPath(input.scopePath);
  const batch = resolveTemplate("comb.review.batch", {
    comment_count: comments.length,
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

/** Multi-line text stays inside its list item. */
function indent(text: string): string {
  return text.replace(/\n/g, "\n    ");
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
