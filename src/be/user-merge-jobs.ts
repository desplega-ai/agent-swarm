/**
 * Resumable background user merges (`user_merge_jobs`).
 *
 * POST /api/users/{id}/merge does the short part in one transaction (moves
 * identities and email aliases, runs the guards, marks the source with
 * `users.mergedIntoUserId`, records the manual_merge event) and inserts a
 * pending job. This module runs the long part: it moves every retained
 * reference to the source user over to the target, in batches, each in its
 * own short transaction, and finally deletes the source row.
 *
 * Why: deleteUser(source, target) inside the request froze the API for 278 s
 * on an 85 GB production database (incident 2026-11-09). Every statement is
 * synchronous bun:sqlite on the event loop, so a request can only stay
 * responsive if no single statement touches more than a few thousand rows.
 *
 * Shape:
 * - One job at a time, process-wide (`runUserMergeJobs` is a mutex; a kick
 *   while a drain runs schedules another pass).
 * - Phase `workflow-context`: rewrite context.swarm.requestedByUserId in the
 *   runs the source requested, by id, found through the expression index on
 *   the context requester (selectWorkflowRunsRequestedBy).
 * - Phase `<table>.<column>`: one discovered user FK column at a time,
 *   `batchSize` rows per transaction, until a batch comes back short.
 * - Phase `delete-user`: one short transaction that sweeps every column once
 *   more (only the rows written since that column's pass: a running workflow
 *   or an agent task still holds the source id in memory and keeps inserting
 *   rows that name it), then DELETE FROM users, then the done mark. The sweep
 *   and the delete share the write lock, so no row can slip in between and
 *   fail the FK parent-delete check.
 * - Paced like src/be/boot-scrub-sweep.ts: after each batch the runner rests
 *   for a multiple of the batch's own duration, and the multiple follows the
 *   event-loop lag it measures on its own timer.
 *
 * Every batch is idempotent (rows already moved no longer match the source),
 * so a crash or a thrown test hook leaves a consistent database and the next
 * run continues from the first unprocessed row. `progress` records rows
 * rewritten per phase for the UI; it is written in the same transaction as
 * the batch.
 *
 * Failures: a thrown attempt puts the job back to `pending` with the error
 * and a `nextAttemptAt` in the future (bounded exponential backoff), and a
 * timer kicks the runner then. After USER_MERGE_MAX_ATTEMPTS the job is
 * `failed`; a repeat POST of the same merge re-queues it (requeueUserMergeJob).
 * A missing target is terminal at once (TerminalUserMergeError): no retry can
 * help, and the route lets the operator merge the source elsewhere. On boot,
 * resumeUserMergeJobs re-queues the jobs the previous process left running and
 * clears pending backoffs; failed jobs stay failed.
 *
 * Human-free reclassification (reclassifyTaskHumanFree) is not needed here:
 * the rule only changes when a requester becomes NULL, and a merge always
 * replaces the source with the target.
 */

import { invalidateTelemetryUserRole, scheduleOrgDomainRecompute } from "../telemetry-identity";
import type { UserMergeJob, UserMergeJobStatus } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { nextRestRatio } from "./boot-scrub-sweep";
import { getDbClient } from "./db";
import {
  discoverUserReferenceColumns,
  rewriteUserReferenceColumn,
  rewriteWorkflowRunRequester,
  selectWorkflowRunsRequestedBy,
  type UserReferenceColumn,
} from "./db/users/references";
import type { DbExecutor } from "./db-client";

/** Rows per transaction. On the incident tables this keeps a batch well under 100 ms. */
export const USER_MERGE_BATCH_SIZE = 5000;

/** Claims of one job before it is marked failed for good. */
export const USER_MERGE_MAX_ATTEMPTS = 5;

export const WORKFLOW_CONTEXT_PHASE = "workflow-context";
export const DELETE_USER_PHASE = "delete-user";

/** An error no retry can fix: the job is marked failed without a backoff. */
export class TerminalUserMergeError extends Error {}

type UserMergeJobRow = {
  id: string;
  sourceUserId: string;
  targetUserId: string;
  status: UserMergeJobStatus;
  phase: string | null;
  progress: string;
  error: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

function rowToJob(row: UserMergeJobRow): UserMergeJob {
  let progress: Record<string, number> = {};
  try {
    const parsed = JSON.parse(row.progress) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      progress = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      );
    }
  } catch {
    // A malformed progress blob only loses the per-phase counts.
  }
  return {
    id: row.id,
    sourceUserId: row.sourceUserId,
    targetUserId: row.targetUserId,
    status: row.status,
    phase: row.phase,
    progress,
    error: row.error,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

// ---------------------------------------------------------------------------
// Job rows
// ---------------------------------------------------------------------------

/** Insert a pending job. Joins the caller's transaction when there is one. */
export async function createUserMergeJob(input: {
  sourceUserId: string;
  targetUserId: string;
  createdBy?: string | null;
}): Promise<UserMergeJob> {
  if (input.sourceUserId === input.targetUserId) {
    throw new Error("Merge source and target must differ");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = await getDbClient().get<UserMergeJobRow>(
    `INSERT INTO user_merge_jobs
       (id, sourceUserId, targetUserId, status, progress, createdAt, created_by, updated_by)
     VALUES (?, ?, ?, 'pending', '{}', ?, ?, ?)
     RETURNING *`,
    [
      id,
      input.sourceUserId,
      input.targetUserId,
      now,
      input.createdBy ?? null,
      input.createdBy ?? null,
    ],
  );
  if (!row) throw new Error("Failed to create user merge job");
  return rowToJob(row);
}

export async function getUserMergeJob(id: string): Promise<UserMergeJob | null> {
  const row = await getDbClient().get<UserMergeJobRow>(
    "SELECT * FROM user_merge_jobs WHERE id = ?",
    [id],
  );
  return row ? rowToJob(row) : null;
}

export async function listUserMergeJobs(opts?: {
  status?: UserMergeJobStatus;
  limit?: number;
}): Promise<UserMergeJob[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const rows = opts?.status
    ? await getDbClient().query<UserMergeJobRow>(
        "SELECT * FROM user_merge_jobs WHERE status = ? ORDER BY createdAt DESC LIMIT ?",
        [opts.status, limit],
      )
    : await getDbClient().query<UserMergeJobRow>(
        "SELECT * FROM user_merge_jobs ORDER BY createdAt DESC LIMIT ?",
        [limit],
      );
  return rows.map(rowToJob);
}

/** The pending or running job that names `userId` as source or target, if any. */
export async function findActiveUserMergeJob(userId: string): Promise<UserMergeJob | null> {
  const row = await getDbClient().get<UserMergeJobRow>(
    `SELECT * FROM user_merge_jobs
     WHERE status IN ('pending', 'running') AND (sourceUserId = ? OR targetUserId = ?)
     ORDER BY createdAt LIMIT 1`,
    [userId, userId],
  );
  return row ? rowToJob(row) : null;
}

/** The newest failed job that merges `sourceUserId` into `targetUserId`, if any. */
export async function findFailedUserMergeJob(
  sourceUserId: string,
  targetUserId: string,
): Promise<UserMergeJob | null> {
  const row = await getDbClient().get<UserMergeJobRow>(
    `SELECT * FROM user_merge_jobs
     WHERE status = 'failed' AND sourceUserId = ? AND targetUserId = ?
     ORDER BY createdAt DESC LIMIT 1`,
    [sourceUserId, targetUserId],
  );
  return row ? rowToJob(row) : null;
}

/**
 * Put a failed job back in the queue with a fresh attempt budget. The caller
 * kicks runUserMergeJobs (after its transaction commits, when it has one).
 */
export async function requeueUserMergeJob(jobId: string): Promise<UserMergeJob | null> {
  const row = await getDbClient().get<UserMergeJobRow>(
    `UPDATE user_merge_jobs
     SET status = 'pending', error = NULL, attempts = 0, nextAttemptAt = NULL, finishedAt = NULL
     WHERE id = ? AND status = 'failed'
     RETURNING *`,
    [jobId],
  );
  return row ? rowToJob(row) : null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type UserMergeRunnerOptions = {
  /** Rows per transaction. Default USER_MERGE_BATCH_SIZE. */
  batchSize?: number;
  /**
   * Test hook, called after each batch commits. A throw fails the attempt
   * with the batch already committed, which is what a crash mid-job looks like.
   */
  afterBatch?: (info: { jobId: string; phase: string; changes: number }) => void | Promise<void>;
  /** Rest between batches. Default: the lag-following pacer. Tests pass false. */
  pace?: boolean;
  /** Backoff before the next attempt of a failed job. Default: retryDelayMs. */
  retryDelayMs?: (attempt: number) => number;
};

/** Rest ratio bounds, as in boot-scrub-sweep: fastest when idle, slowest when busy. */
const INITIAL_REST_RATIO = 1;
const LAG_SMOOTHING = 0.3;

/** 2 s, 8 s, 32 s, 2 min, capped at 5 min. */
export function retryDelayMs(attempt: number): number {
  return Math.min(2_000 * 4 ** Math.max(0, attempt - 1), 5 * 60_000);
}

/**
 * Rest after each batch for `ratio` times the batch's duration, and move the
 * ratio with how late the rest timer fires (event-loop lag).
 */
function createPacer() {
  let ratio = INITIAL_REST_RATIO;
  let lag = 0;
  return {
    async rest(workedMs: number): Promise<void> {
      const restMs = Math.max(1, workedMs * ratio);
      const restStart = performance.now();
      await new Promise<void>((resolve) => setTimeout(resolve, restMs));
      const late = Math.max(0, performance.now() - restStart - restMs);
      lag = lag * (1 - LAG_SMOOTHING) + late * LAG_SMOOTHING;
      ratio = nextRestRatio(ratio, lag);
    },
  };
}

async function saveProgress(
  tx: DbExecutor,
  jobId: string,
  phase: string,
  progress: Record<string, number>,
): Promise<void> {
  await tx.run("UPDATE user_merge_jobs SET phase = ?, progress = ? WHERE id = ?", [
    phase,
    JSON.stringify(progress),
    jobId,
  ]);
}

async function userExists(executor: DbExecutor, id: string): Promise<boolean> {
  const row = await executor.get<{ present: number }>(
    "SELECT EXISTS(SELECT 1 FROM users WHERE id = ?) AS present",
    [id],
  );
  return row?.present === 1;
}

/** Claim the oldest pending job whose backoff has passed, counting the attempt. */
async function claimNextJob(): Promise<UserMergeJob | null> {
  const now = new Date().toISOString();
  const row = await getDbClient().get<UserMergeJobRow>(
    `UPDATE user_merge_jobs
     SET status = 'running', startedAt = COALESCE(startedAt, ?), attempts = attempts + 1,
         nextAttemptAt = NULL, finishedAt = NULL
     WHERE id = (
       SELECT id FROM user_merge_jobs
       WHERE status = 'pending' AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)
       ORDER BY createdAt LIMIT 1
     )
     RETURNING *`,
    [now, now],
  );
  return row ? rowToJob(row) : null;
}

function errorMessage(error: unknown): string {
  // Free text from an exception: scrub it before it lands (.text-columns.json).
  const message = scrubSecrets(error instanceof Error ? error.message : String(error));
  return message.slice(0, 2000);
}

async function markFailed(jobId: string, error: unknown): Promise<void> {
  await getDbClient().run(
    "UPDATE user_merge_jobs SET status = 'failed', error = ?, finishedAt = ? WHERE id = ?",
    [errorMessage(error), new Date().toISOString(), jobId],
  );
}

/** Back to pending, with the error kept for the UI and a backoff before the next claim. */
async function scheduleRetry(jobId: string, error: unknown, delayMs: number): Promise<void> {
  await getDbClient().run(
    "UPDATE user_merge_jobs SET status = 'pending', error = ?, nextAttemptAt = ? WHERE id = ?",
    [errorMessage(error), new Date(Date.now() + delayMs).toISOString(), jobId],
  );
}

/**
 * Phase 3, one short transaction: sweep every column once more (the rows
 * written since that column's pass), rewrite the context of any run the
 * source requested meanwhile, delete the source row, mark the job done.
 */
async function finishJob(
  job: UserMergeJob,
  progress: Record<string, number>,
  references: UserReferenceColumn[],
): Promise<void> {
  const client = getDbClient();
  // Outside the transaction, so a failed delete still reports its phase.
  await saveProgress(client, job.id, DELETE_USER_PHASE, progress);
  await client.transaction(async (tx) => {
    if (references.length > 0) {
      const runIds = await selectWorkflowRunsRequestedBy(job.sourceUserId, tx);
      const contexts = await rewriteWorkflowRunRequester(
        runIds,
        job.sourceUserId,
        job.targetUserId,
      );
      if (contexts > 0) {
        progress[WORKFLOW_CONTEXT_PHASE] = (progress[WORKFLOW_CONTEXT_PHASE] ?? 0) + contexts;
      }
      for (const reference of references) {
        const changes = await rewriteUserReferenceColumn(
          reference,
          job.sourceUserId,
          job.targetUserId,
        );
        if (changes > 0) {
          const phase = `${reference.tableName}.${reference.columnName}`;
          progress[phase] = (progress[phase] ?? 0) + changes;
        }
      }
    }
    const result = await tx.run("DELETE FROM users WHERE id = ?", [job.sourceUserId]);
    progress[DELETE_USER_PHASE] = (progress[DELETE_USER_PHASE] ?? 0) + result.changes;
    await tx.run(
      `UPDATE user_merge_jobs
       SET status = 'done', phase = ?, progress = ?, error = NULL, finishedAt = ?
       WHERE id = ?`,
      [DELETE_USER_PHASE, JSON.stringify(progress), new Date().toISOString(), job.id],
    );
    client.afterCommit(() => {
      invalidateTelemetryUserRole(job.sourceUserId);
      invalidateTelemetryUserRole(job.targetUserId);
      scheduleOrgDomainRecompute();
    });
  });
}

async function runJob(job: UserMergeJob, options: UserMergeRunnerOptions): Promise<void> {
  const client = getDbClient();
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? USER_MERGE_BATCH_SIZE));
  const pacer = options.pace === false ? null : createPacer();
  const progress: Record<string, number> = { ...job.progress };

  // After every committed batch: the test hook (real batches only), then a
  // rest so queued requests get the event loop.
  const afterBatch = async (phase: string, changes: number, workedMs: number) => {
    if (changes > 0) await options.afterBatch?.({ jobId: job.id, phase, changes });
    if (pacer && changes > 0) await pacer.rest(workedMs);
    else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  if (!(await userExists(client, job.sourceUserId))) {
    // Deleted by another path (the manage-user tool) or by this job's own
    // delete before the done mark was written: nothing left to move.
    await finishJob(job, progress, []);
    return;
  }
  if (!(await userExists(client, job.targetUserId))) {
    throw new TerminalUserMergeError("Target user not found");
  }

  // Phase 1: the workflow context requester. Each batch selects the next ids
  // (a rewritten run no longer matches the filter, so the same query walks
  // forward) and rewrites them in one transaction.
  while (true) {
    const started = performance.now();
    const changes = await client.transaction(async (tx) => {
      const runIds = await selectWorkflowRunsRequestedBy(job.sourceUserId, tx, batchSize);
      if (runIds.length === 0) return 0;
      const rewritten = await rewriteWorkflowRunRequester(
        runIds,
        job.sourceUserId,
        job.targetUserId,
      );
      if (rewritten > 0) {
        progress[WORKFLOW_CONTEXT_PHASE] = (progress[WORKFLOW_CONTEXT_PHASE] ?? 0) + rewritten;
      }
      await saveProgress(tx, job.id, WORKFLOW_CONTEXT_PHASE, progress);
      return rewritten;
    });
    await afterBatch(WORKFLOW_CONTEXT_PHASE, changes, performance.now() - started);
    // A short batch means no run names the source any more. A selected run
    // always changes (its requester is the source), so this also ends the
    // loop when the filter and the UPDATE ever disagree.
    if (changes < batchSize) break;
  }

  // Phase 2: every discovered user FK column, batchSize rows per transaction.
  const references = await discoverUserReferenceColumns();
  for (const reference of references) {
    const phase = `${reference.tableName}.${reference.columnName}`;
    while (true) {
      const started = performance.now();
      const changes = await client.transaction(async (tx) => {
        const rewritten = await rewriteUserReferenceColumn(
          reference,
          job.sourceUserId,
          job.targetUserId,
          batchSize,
        );
        if (rewritten > 0) progress[phase] = (progress[phase] ?? 0) + rewritten;
        await saveProgress(tx, job.id, phase, progress);
        return rewritten;
      });
      await afterBatch(phase, changes, performance.now() - started);
      // A short batch means the column holds no more rows for the source.
      if (changes < batchSize) break;
    }
  }

  // Phase 3: the tail sweep and the source row itself.
  await finishJob(job, progress, references);
}

const retryTimers = new Set<ReturnType<typeof setTimeout>>();

function armRetry(delayMs: number, options: UserMergeRunnerOptions): void {
  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    void runUserMergeJobs(options);
  }, delayMs);
  timer.unref?.();
  retryTimers.add(timer);
}

async function drain(options: UserMergeRunnerOptions): Promise<void> {
  while (true) {
    const job = await claimNextJob();
    if (!job) return;
    const started = performance.now();
    try {
      await runJob(job, options);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`[user-merge] job ${job.id} done in ${seconds}s`);
    } catch (err) {
      const terminal =
        err instanceof TerminalUserMergeError || job.attempts >= USER_MERGE_MAX_ATTEMPTS;
      try {
        if (terminal) {
          console.error(`[user-merge] job ${job.id} failed (attempt ${job.attempts}):`, err);
          await markFailed(job.id, err);
        } else {
          const delayMs = (options.retryDelayMs ?? retryDelayMs)(job.attempts);
          console.error(
            `[user-merge] job ${job.id} attempt ${job.attempts} failed, retrying in ${Math.round(delayMs / 1000)}s:`,
            err,
          );
          await scheduleRetry(job.id, err, delayMs);
          armRetry(delayMs, options);
        }
      } catch (markErr) {
        console.error(`[user-merge] could not record the failure of job ${job.id}:`, markErr);
      }
    }
  }
}

let active: Promise<void> | null = null;
let rerun = false;
let pausedForTests = false;

/**
 * Test switch: while paused, runUserMergeJobs returns at once without
 * draining, so a test can observe a pending job. Unpausing does not start a
 * drain; the test calls runUserMergeJobs itself.
 */
export function pauseUserMergeRunnerForTests(paused: boolean): void {
  pausedForTests = paused;
}

/** Test helper: drop the retry timers armed by failed attempts. */
export function clearUserMergeRetryTimersForTests(): void {
  for (const timer of retryTimers) clearTimeout(timer);
  retryTimers.clear();
}

/**
 * Drain pending jobs, one at a time, process-wide. A call while a drain is
 * running returns that drain and schedules one more pass after it, so a job
 * queued meanwhile is never left pending.
 */
export function runUserMergeJobs(options: UserMergeRunnerOptions = {}): Promise<void> {
  if (pausedForTests) return Promise.resolve();
  if (active) {
    rerun = true;
    return active;
  }
  active = (async () => {
    try {
      do {
        rerun = false;
        await drain(options);
      } while (rerun);
    } finally {
      active = null;
    }
  })();
  return active;
}

/**
 * Boot: a job left running by a crash goes back to pending, a pending job
 * waiting out a backoff becomes due now, and the drain starts. Every batch is
 * idempotent, so the job continues from the first row the last committed
 * batch did not reach. Failed jobs stay failed: they already spent their
 * attempts or hit a terminal error, and a repeat POST re-queues them.
 */
export async function resumeUserMergeJobs(options: UserMergeRunnerOptions = {}): Promise<void> {
  const requeued = await getDbClient().run(
    `UPDATE user_merge_jobs SET status = 'pending', nextAttemptAt = NULL, finishedAt = NULL
     WHERE status = 'running' OR (status = 'pending' AND nextAttemptAt IS NOT NULL)`,
  );
  const pending = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM user_merge_jobs WHERE status = 'pending'",
  );
  if (!pending || pending.n === 0) return;
  console.log(
    `[user-merge] resuming ${pending.n} job(s) (${requeued.changes} re-queued after restart)`,
  );
  await runUserMergeJobs(options);
}
