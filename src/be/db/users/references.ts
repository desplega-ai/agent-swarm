/**
 * Batched access to the retained references of a user: every nullable column
 * with a FOREIGN KEY to users(id) and no ON DELETE action, plus the requester
 * inside the workflow_runs context JSON.
 *
 * deleteUser (src/be/db.ts) rewrites them in one transaction with the SQL in
 * src/be/db/user-references.ts. The merge job (src/be/user-merge-jobs.ts)
 * rewrites them in batches through these helpers, which are built on that
 * same SQL (the discovery query, the whole-column UPDATE and the indexed
 * requester expression), so the two paths cannot drift.
 */

import type { DbExecutor } from "../../db-client";
import { openSealedJson, sealJson } from "../../sealed-json";
import { getDbClient } from "../runtime";
import {
  quoteSqlIdentifier,
  USER_REFERENCE_COLUMNS_SQL,
  type UserReferenceRow,
  userReferenceRewriteSql,
  WORKFLOW_CONTEXT_REQUESTER_SQL,
} from "../user-references";

/**
 * A nullable column that references users(id) and keeps its value when the
 * user is deleted (no ON DELETE action). `withoutRowid` tables are batched by
 * their primary key columns (`keyColumns`) instead of rowid.
 */
export type UserReferenceColumn = UserReferenceRow & {
  withoutRowid: boolean;
  keyColumns: string[];
};

/**
 * Discover every column deleteUser and the merge job must rewrite (the same
 * query deleteUser runs), plus the batch key of each table: rowid, or the
 * primary key for WITHOUT ROWID tables such as kv_entries.
 */
export async function discoverUserReferenceColumns(
  executor: DbExecutor = getDbClient(),
): Promise<UserReferenceColumn[]> {
  const rows = await executor.query<UserReferenceRow>(USER_REFERENCE_COLUMNS_SQL);
  const withoutRowidByTable = new Map<string, boolean>();
  const references: UserReferenceColumn[] = [];
  for (const row of rows) {
    let withoutRowid = withoutRowidByTable.get(row.tableName);
    if (withoutRowid === undefined) {
      const table = await executor.get<{ withoutRowid: number }>(
        `SELECT instr(upper(sql), 'WITHOUT ROWID') > 0 AS withoutRowid
         FROM sqlite_schema WHERE type = 'table' AND name = ?`,
        [row.tableName],
      );
      withoutRowid = Boolean(table?.withoutRowid);
      withoutRowidByTable.set(row.tableName, withoutRowid);
    }
    let keyColumns = ["rowid"];
    if (withoutRowid) {
      const pk = await executor.query<{ name: string }>(
        "SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk",
        [row.tableName],
      );
      keyColumns = pk.map((column) => column.name);
    }
    references.push({ ...row, withoutRowid, keyColumns });
  }
  return references;
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
  if (limit === undefined) {
    const result = await getDbClient().run(userReferenceRewriteSql(reference), [
      replacementUserId,
      userId,
    ]);
    return result.changes;
  }
  const table = quoteSqlIdentifier(reference.tableName);
  const column = quoteSqlIdentifier(reference.columnName);
  const keys = reference.keyColumns.map(quoteSqlIdentifier).join(", ");
  const keyTuple = reference.keyColumns.length === 1 ? keys : `(${keys})`;
  const result = await getDbClient().run(
    `UPDATE ${table} SET ${column} = ?
     WHERE ${keyTuple} IN (SELECT ${keys} FROM ${table} WHERE ${column} = ? LIMIT ?)`,
    [replacementUserId, userId, limit],
  );
  return result.changes;
}

/**
 * Ids of the workflow runs whose context names `userId` as the requester,
 * oldest id first. Filters on the exact expression migration 319 indexes
 * (idx_workflow_runs_context_requester), so this is an index lookup and not
 * a JSON parse of every row (153 s on 493k prod rows).
 */
export async function selectWorkflowRunsRequestedBy(
  userId: string,
  executor: DbExecutor = getDbClient(),
  limit?: number,
): Promise<string[]> {
  const rows = await executor.query<{ id: string }>(
    `SELECT id FROM workflow_runs
     WHERE ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?
     ORDER BY id
     LIMIT ?`,
    [userId, limit ?? -1],
  );
  return rows.map((row) => row.id);
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
  const client = getDbClient();
  const placeholders = runIds.map(() => "?").join(", ");
  // The sealed replay copy is what a resume reads, so rewrite it first.
  const sealedContexts = await client.query<{ id: string; context_replay: string }>(
    `SELECT id, context_replay FROM workflow_runs
     WHERE id IN (${placeholders})
       AND context_replay IS NOT NULL
       AND ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?`,
    [...runIds, userId],
  );
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
    await client.run("UPDATE workflow_runs SET context_replay = ? WHERE id = ?", [
      sealJson({ ...context, swarm }),
      row.id,
    ]);
  }
  const result = replacementUserId
    ? await client.run(
        `UPDATE workflow_runs
         SET context = json_set(context, '$.swarm.requestedByUserId', ?)
         WHERE id IN (${placeholders})
           AND ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?`,
        [replacementUserId, ...runIds, userId],
      )
    : await client.run(
        `UPDATE workflow_runs
         SET context = json_remove(context, '$.swarm.requestedByUserId')
         WHERE id IN (${placeholders})
           AND ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?`,
        [...runIds, userId],
      );
  return result.changes;
}
