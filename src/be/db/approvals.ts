import { normalizeDate, normalizeDateRequired } from "../date-utils";
import { getDbClient } from "./runtime";

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
}

export interface ApprovalRequestListFilters {
  status?: string;
  workflowRunId?: string;
  limit?: number;
}

/** WHERE + LIMIT shared by the full and slim approval list reads (default limit 100). */
export function approvalRequestListClause(filters?: ApprovalRequestListFilters): {
  sql: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters?.workflowRunId) {
    conditions.push("workflowRunId = ?");
    params.push(filters.workflowRunId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(filters?.limit ?? 100);
  return { sql: `${where} ORDER BY createdAt DESC LIMIT ?`, params };
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

type ApprovalRequestSummaryRow = Omit<ApprovalRequestSummary, "questionCount" | "createdBy"> & {
  questionCount: number | null;
  created_by: string | null;
};

export async function listApprovalRequestSummaries(
  filters?: ApprovalRequestListFilters,
): Promise<ApprovalRequestSummary[]> {
  const { sql, params } = approvalRequestListClause(filters);
  // Project in SQL so the heavy JSON columns are never read or parsed.
  const rows = await getDbClient().query<ApprovalRequestSummaryRow>(
    `SELECT id, title, workflowRunId, workflowRunStepId, sourceTaskId, status, resolvedBy,
            resolvedAt, timeoutSeconds, expiresAt, created_by, createdAt, updatedAt,
            json_array_length(questions) AS questionCount
       FROM approval_requests ${sql}`,
    params,
  );
  return rows.map(({ created_by, questionCount, ...row }) => ({
    ...row,
    questionCount: questionCount ?? 0,
    resolvedAt: normalizeDate(row.resolvedAt),
    expiresAt: normalizeDate(row.expiresAt),
    createdBy: created_by ?? undefined,
    createdAt: normalizeDateRequired(row.createdAt),
    updatedAt: normalizeDateRequired(row.updatedAt),
  }));
}

/**
 * Records the answers collected so far on a request that stays pending (an
 * `all` or `{ min: N }` policy still short of its quorum). False when the row
 * is no longer pending.
 */
export async function recordApprovalVotes(id: string, approvals: ApprovalVote[]): Promise<boolean> {
  const row = await getDbClient().get<{ id: string }>(
    `UPDATE approval_requests
       SET approvals = ?, updatedAt = ?
       WHERE id = ? AND status = 'pending'
       RETURNING id`,
    [JSON.stringify(approvals), new Date().toISOString(), id],
  );
  return row !== null && row !== undefined;
}
