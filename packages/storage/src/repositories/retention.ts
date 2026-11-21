import type { SqlExecutor } from "../executor";

/**
 * Domain: database retention. Bounded deletes over the tables the closed
 * policy list in `src/be/db-retention.ts` names (table and column names come
 * from code, never from input), the workflow-run tree batch, and the space
 * reclaim after a sweep. Batch sizing, deadlines, telemetry and scheduling
 * stay in `src/`.
 */

/** One table sweep under its policy, with the bound already computed. */
export type RetentionSweep =
  | {
      policy: "age";
      table: string;
      /** Rows whose `timeColumn` sorts before `cutoff` are eligible. */
      timeColumn: string;
      cutoff: string;
      /** Only rows whose `statusColumn` is one of `terminalStatuses`. */
      statusColumn?: string;
      terminalStatuses?: readonly string[];
      /** Rows where this column is non-NULL are kept. */
      keepWhenSet?: string;
    }
  | {
      policy: "keepLatest";
      table: string;
      /** Comma-separated partition columns. */
      partitionBy: string;
      rankBy: string;
      /** Rows kept per partition (newest `rankBy` first). */
      keep: number;
    }
  | {
      policy: "workflowRuns";
      table: "workflow_runs";
      /** `YYYY-MM-DD HH:MM:SS`: terminal trees finished before it are eligible. */
      cutoff: string;
      /** Deepest run tree traversed; a deeper or cyclic tree is never eligible. */
      maxDepth: number;
    };

export type WorkflowRunRetentionCandidate = { id: string; definitionHash: string | null };

export interface RetentionRepository {
  /** Rows the sweep would delete now (its backlog). */
  countBacklog(sweep: RetentionSweep): Promise<number>;
  /**
   * One autocommit batch: deletes at most `limit` eligible rows, oldest
   * (`age`) or deepest history (`keepLatest`) first. `executionMs` is the
   * time the driver spent executing (lock waits and BUSY retry sleeps
   * excluded). Not for `workflowRuns`: use the workflow-run methods inside
   * one transaction.
   */
  deleteBatch(
    sweep: RetentionSweep,
    limit: number,
  ): Promise<{ changes: number; executionMs: number }>;
  /** The next eligible workflow runs, ordered by `finishedAt`, then `id` (total). */
  listWorkflowRunCandidates(
    cutoff: string,
    limit: number,
    maxDepth: number,
  ): Promise<WorkflowRunRetentionCandidate[]>;
  /**
   * Delete the given runs and their steps. Before that it unlinks the tasks
   * that point at a run or step, and deletes their approval requests and wait
   * states. Returns the ids of the unlinked tasks (no order). Call inside a
   * transaction.
   */
  deleteWorkflowRuns(runIds: string[]): Promise<string[]>;
  /** Return up to `pages` free pages to the file system, where the engine supports it. */
  incrementalVacuum(pages: number): Promise<void>;
}

/** Every statement of this domain is engine-specific (row ids, numbered parameters, JSON arrays, PRAGMA). */
export abstract class BaseRetentionRepository implements RetentionRepository {
  constructor(protected readonly db: SqlExecutor) {}

  abstract countBacklog(sweep: RetentionSweep): Promise<number>;
  abstract deleteBatch(
    sweep: RetentionSweep,
    limit: number,
  ): Promise<{ changes: number; executionMs: number }>;
  abstract listWorkflowRunCandidates(
    cutoff: string,
    limit: number,
    maxDepth: number,
  ): Promise<WorkflowRunRetentionCandidate[]>;
  abstract deleteWorkflowRuns(runIds: string[]): Promise<string[]>;
  abstract incrementalVacuum(pages: number): Promise<void>;
}
