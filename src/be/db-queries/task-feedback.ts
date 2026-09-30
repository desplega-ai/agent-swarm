import { getDbClient } from "../db";

export type TaskFeedbackSource = "slack" | "ui" | "api";
export type TaskFeedbackRating = 1 | -1;

export interface TaskFeedback {
  id: string;
  taskId: string;
  agentId: string | null;
  rating: TaskFeedbackRating;
  note: string | null;
  source: TaskFeedbackSource;
  sourceRef: Record<string, unknown> | null;
  requestedByUserId: string | null;
  createdAt: string;
}

type TaskFeedbackRow = Omit<TaskFeedback, "sourceRef"> & { sourceRef: string | null };

const MAX_NOTE_LENGTH = 2_000;

function toFeedback(row: TaskFeedbackRow): TaskFeedback {
  return { ...row, sourceRef: row.sourceRef ? JSON.parse(row.sourceRef) : null };
}

/** Record one rating. `agentId` defaults to the task's assignee. */
export async function recordTaskFeedback(input: {
  taskId: string;
  rating: TaskFeedbackRating;
  note?: string | null;
  source: TaskFeedbackSource;
  sourceRef?: Record<string, unknown>;
  requestedByUserId?: string | null;
  agentId?: string | null;
}): Promise<TaskFeedback> {
  const note = input.note?.trim().slice(0, MAX_NOTE_LENGTH) || null;
  const userId = input.requestedByUserId ?? null;
  const row = await getDbClient().get<TaskFeedbackRow>(
    `INSERT INTO task_feedback
       (id, taskId, agentId, rating, note, source, sourceRef, requestedByUserId, created_by, updated_by)
     VALUES (?, ?, COALESCE(?, (SELECT agentId FROM agent_tasks WHERE id = ?)), ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, taskId, agentId, rating, note, source, sourceRef, requestedByUserId, createdAt`,
    [
      crypto.randomUUID(),
      input.taskId,
      input.agentId ?? null,
      input.taskId,
      input.rating,
      note,
      input.source,
      input.sourceRef ? JSON.stringify(input.sourceRef) : null,
      userId,
      userId,
      userId,
    ],
  );
  if (!row) throw new Error(`Failed to record feedback for task ${input.taskId}`);
  return toFeedback(row);
}

/** Newest first. `since` is an inclusive ISO timestamp. */
export async function listTaskFeedback(
  filters: {
    since?: string;
    rating?: TaskFeedbackRating;
    source?: TaskFeedbackSource;
    agentId?: string;
    taskId?: string;
    limit?: number;
  } = {},
): Promise<TaskFeedback[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filters.since) {
    where.push("createdAt >= ?");
    params.push(filters.since);
  }
  if (filters.rating !== undefined) {
    where.push("rating = ?");
    params.push(filters.rating);
  }
  if (filters.source) {
    where.push("source = ?");
    params.push(filters.source);
  }
  if (filters.agentId) {
    where.push("agentId = ?");
    params.push(filters.agentId);
  }
  if (filters.taskId) {
    where.push("taskId = ?");
    params.push(filters.taskId);
  }
  params.push(Math.min(Math.max(filters.limit ?? 50, 1), 500));
  const rows = await getDbClient().query<TaskFeedbackRow>(
    `SELECT id, taskId, agentId, rating, note, source, sourceRef, requestedByUserId, createdAt
       FROM task_feedback
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY createdAt DESC, id DESC
      LIMIT ?`,
    params,
  );
  return rows.map(toFeedback);
}
