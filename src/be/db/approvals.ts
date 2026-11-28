import type { ApprovalListFilter } from "@desplega/storage";
import { type ScrubbedText, scrubObject, scrubSecrets } from "../../utils/secret-scrubber";
import { normalizeDate, normalizeDateRequired } from "../date-utils";
import { breaksJsonValidity } from "../scrub-json";
import { getStorage } from "../storage";

/**
 * One accepted answer to an approval request. `responder` comes from the
 * request's credential (a user id, or "operator" for the shared key);
 * `claimedRespondedBy` is the client's unverified `respondedBy`, kept for display only.
 */
export interface ApprovalVote {
  responder: string;
  approved: boolean;
  responses: Record<string, unknown>;
  claimedRespondedBy?: string;
  respondedAt: string;
  /** Set when the answer came from a chat button: the channel and the clicking platform user. */
  via?: { channel: string; platformUserId: string };
}

export interface ApprovalRequestListFilters {
  status?: string;
  workflowRunId?: string;
  limit?: number;
}

/** Filters shared by the full and slim approval list reads (default limit 100). */
export function approvalListFilter(filters?: ApprovalRequestListFilters): ApprovalListFilter {
  return {
    status: filters?.status || undefined,
    workflowRunId: filters?.workflowRunId || undefined,
    limit: filters?.limit ?? 100,
  };
}

/**
 * Slim approval list row: what the approvals list page draws. The question
 * bodies, answers, approvers and notification targets are dropped (read them
 * via `getApprovalRequestById`); `questionCount` replaces `questions`.
 */
export interface ApprovalRequestSummary {
  id: string;
  title: string;
  questionCount: number;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  sourceTaskId: string | null;
  status: "pending" | "approved" | "rejected" | "timeout" | "cancelled";
  resolvedBy: string | null;
  resolvedAt: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export async function listApprovalRequestSummaries(
  filters?: ApprovalRequestListFilters,
): Promise<ApprovalRequestSummary[]> {
  const rows = await getStorage().repos.workflows.listApprovalSummaries(
    approvalListFilter(filters),
  );
  return rows.map(({ created_by, questionCount, ...row }) => ({
    ...row,
    status: row.status as ApprovalRequestSummary["status"],
    questionCount: questionCount ?? 0,
    resolvedAt: normalizeDate(row.resolvedAt),
    expiresAt: normalizeDate(row.expiresAt),
    createdBy: created_by ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  }));
}

/**
 * The approvers policy and the answers collected so far, for the given pending
 * requests only. The slim list reads this to show quorum progress without
 * projecting the full rows.
 */
export async function getPendingApprovalVoteState(
  ids: string[],
): Promise<{ id: string; approvers: unknown; approvals: ApprovalVote[] | null }[]> {
  if (ids.length === 0) return [];
  const rows = await getStorage().repos.workflows.listPendingApprovalVotes(ids);
  return rows.map((row) => ({
    id: row.id,
    approvers: JSON.parse(row.approvers),
    approvals: row.approvals ? JSON.parse(row.approvals) : null,
  }));
}

/**
 * Records the answers collected so far on a request that stays pending (an
 * `all` or `{ min: N }` policy still short of its quorum). False when the row
 * is no longer pending.
 */
export async function recordApprovalVotes(id: string, approvals: ApprovalVote[]): Promise<boolean> {
  return getStorage().repos.workflows.recordApprovalVotes(
    id,
    scrubApprovalVotesJson(approvals),
    new Date().toISOString(),
  );
}

/**
 * Serializes votes for the `approvals` column with free-text answers scrubbed.
 * Falls back to a per-value scrub when a redaction would break the JSON, so
 * readers can always parse the column.
 */
export function scrubApprovalVotesJson(approvals: ApprovalVote[]): ScrubbedText {
  const raw = JSON.stringify(approvals);
  const scrubbed = scrubSecrets(raw);
  if (!breaksJsonValidity(raw, scrubbed)) return scrubbed;
  return JSON.stringify(scrubObject(approvals)) as ScrubbedText;
}

/** Pending approval summaries for an already loaded session chain. */
export async function getPendingApprovalsForTasks(taskIds: string[]): Promise<
  {
    id: string;
    status: "pending";
    sourceTaskId: string;
    title: string;
  }[]
> {
  if (!taskIds.length) return [];
  return getStorage().repos.workflows.listPendingApprovalsForTasks(taskIds);
}

/** The claim key of one Slack thread's cancellation post: `<channel>:<messageTs>`. */
export function approvalCancellationNotificationKey(target: string, messageTs: string): string {
  return `${target}:${messageTs}`;
}

/**
 * Ids of the cancelled requests of the given runs with a Slack cancellation
 * post not yet delivered (never claimed, or a claim a failed post released).
 * A delivered post never comes back, so a repeat cancel of a settled tree
 * retries only what failed. One query per 500 runs.
 */
export async function listUndeliveredCancelledApprovalRequestIds(
  runIds: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < runIds.length; i += 500) {
    const chunk = runIds.slice(i, i + 500);
    const rows = await getStorage().repos.workflows.listCancelledNotifiedApprovals(chunk);
    for (const row of rows) {
      const claims = row.claims ? (JSON.parse(row.claims) as Record<string, unknown>) : {};
      const channels = JSON.parse(row.notificationChannels) as Array<{
        channel?: string;
        target?: string;
        messageTs?: string;
      }>;
      const undelivered = channels.some(
        (n) =>
          n.channel === "slack" &&
          n.target &&
          n.messageTs &&
          claims[approvalCancellationNotificationKey(n.target, n.messageTs)] !== "delivered",
      );
      if (undelivered) ids.push(row.id);
    }
  }
  return ids;
}

/**
 * Every terminal transition passes through here: once it commits, edit each
 * request's Slack and Telegram cards to show the outcome. Fire and forget; a Slack failure
 * never touches the resolution.
 */
export function scheduleApprovalCardUpdates(
  approvals: Array<{ id: string; notificationChannels: unknown[] | null }>,
): void {
  const posted = approvals.filter((approval) =>
    (
      approval.notificationChannels as Array<{
        channel?: string;
        messageTs?: string;
        messageId?: string;
      }> | null
    )?.some(
      (n) => (n.channel === "slack" && n.messageTs) || (n.channel === "telegram" && n.messageId),
    ),
  );
  if (posted.length === 0) return;
  getStorage().afterCommit(() =>
    import("../../workflows/approval-notifications")
      .then(({ updateResolvedApprovalCards }) => updateResolvedApprovalCards(posted))
      .catch((err) =>
        console.error(
          "[HITL] Slack card update not run:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        ),
      ),
  );
}
