/**
 * Batched access to the retained references of a user: every nullable column
 * with a FOREIGN KEY to users(id) and no ON DELETE action, plus the requester
 * inside the workflow_runs context JSON.
 *
 * deleteUser (src/be/db.ts) rewrites them in one transaction with the SQL
 * re-exported by src/be/db/user-references.ts. The merge job
 * (src/be/user-merge-jobs.ts) rewrites them in batches through these helpers,
 * which delegate to the users repository; it runs that same SQL (the
 * discovery query, the whole-column UPDATE and the indexed requester
 * expression, all in packages/storage-sqlite/src/repositories/user-references.ts),
 * so the two paths cannot drift.
 */

import type { UserReferenceColumn } from "@desplega/storage";
import { openSealedJson, sealJson } from "../../sealed-json";
import { getStorage } from "../../storage";

export type { UserReferenceColumn };

const usersRepo = () => getStorage().repos.users;

/**
 * Discover every column deleteUser and the merge job must rewrite (the same
 * query deleteUser runs), plus the batch key of each table: rowid, or the
 * primary key for WITHOUT ROWID tables such as kv_entries. Joins the ambient
 * transaction.
 */
export async function discoverUserReferenceColumns(): Promise<UserReferenceColumn[]> {
  return await usersRepo().listUserReferenceColumns();
}

/**
 * Move `userId` to `replacementUserId` (or NULL) in one discovered column.
 * Without `limit` this is deleteUser's whole-column UPDATE. With `limit`,
 * only that many rows change per call (the batch key is the rowid, or the
 * primary key for WITHOUT ROWID tables), so a caller can loop in short
 * transactions until a batch comes back short. Joins the ambient transaction.
 *
 * Migration 319 indexes every discovered column (the user-delete-perf test
 * pins the plans), so both forms are index lookups rather than table scans.
 */
export async function rewriteUserReferenceColumn(
  reference: UserReferenceColumn,
  userId: string,
  replacementUserId: string | null,
  limit?: number,
): Promise<number> {
  return await usersRepo().rewriteUserReferenceColumn(reference, userId, replacementUserId, limit);
}

/**
 * Ids of the workflow runs whose context names `userId` as the requester,
 * oldest id first. Filters on the exact expression migration 319 indexes
 * (idx_workflow_runs_context_requester), so this is an index lookup and not
 * a JSON parse of every row (153 s on 493k prod rows). The second parameter
 * is unused (it was an executor; repository calls join the ambient
 * transaction) and stays so positional callers keep working.
 */
export async function selectWorkflowRunsRequestedBy(
  userId: string,
  _unused?: undefined,
  limit?: number,
): Promise<string[]> {
  return await usersRepo().listWorkflowRunIdsRequestedBy(userId, limit);
}

/**
 * Rewrite context.swarm.requestedByUserId from `userId` to
 * `replacementUserId` (or remove it) in the given runs, in both the scrubbed
 * context column and the sealed replay copy a resume reads. Workflow context
 * is persisted JSON rather than a relational column, but it exposes the same
 * requester identity to downstream interpolation, so it must follow
 * workflow_runs.created_by. Joins the ambient transaction. Idempotent: a run
 * whose context no longer names `userId` is left alone. Returns the number of
 * context rows changed.
 */
export async function rewriteWorkflowRunRequester(
  runIds: string[],
  userId: string,
  replacementUserId: string | null,
): Promise<number> {
  if (runIds.length === 0) return 0;
  const repo = usersRepo();
  // The sealed replay copy is what a resume reads, so rewrite it first.
  const sealedContexts = await repo.listSealedWorkflowContextsRequestedBy(runIds, userId);
  for (const row of sealedContexts) {
    let context: Record<string, unknown>;
    try {
      context = openSealedJson(row.context_replay) as Record<string, unknown>;
    } catch {
      // Unreadable replay state fails the run on resume
      // (WorkflowReplayStateError), so the stale id is never replayed.
      continue;
    }
    const swarm = { ...(context.swarm as Record<string, unknown> | undefined) };
    if (swarm.requestedByUserId !== userId) continue;
    if (replacementUserId) swarm.requestedByUserId = replacementUserId;
    else delete swarm.requestedByUserId;
    await repo.setWorkflowRunContextReplay(row.id, sealJson({ ...context, swarm }));
  }
  return await repo.rewriteWorkflowRunContextRequester(runIds, userId, replacementUserId);
}
