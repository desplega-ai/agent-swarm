/**
 * SQL that deleteUser and the merge job run to move or clear every reference
 * to a user.
 *
 * The statements are exported (and re-exported from src/be/db/user-references.ts)
 * so the query-plan test (src/tests/user-delete-perf.test.ts) explains the
 * exact SQL that production executes. Incident 2026-11-09: a user merge ran
 * these statements as full table scans on an 85 GB database and blocked the
 * API for 278 s.
 */
import type { UserReferenceRow } from "@desplega/storage";

export function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Every nullable column with a FOREIGN KEY to users(id) and no ON DELETE
 * action, plus the two scheduled_tasks audit columns whose FKs migration 103
 * dropped while recreating that table.
 */
export const USER_REFERENCE_COLUMNS_SQL = `SELECT tables.name AS tableName, foreign_keys."from" AS columnName
       FROM sqlite_schema AS tables
       JOIN pragma_foreign_key_list(tables.name) AS foreign_keys
       JOIN pragma_table_info(tables.name) AS columns
         ON columns.name = foreign_keys."from"
       WHERE tables.type = 'table'
         AND foreign_keys."table" = 'users'
         AND foreign_keys.on_delete IN ('NO ACTION', 'RESTRICT')
         AND columns."notnull" = 0
       UNION ALL
       SELECT 'scheduled_tasks' AS tableName, columns.name AS columnName
       FROM pragma_table_info('scheduled_tasks') AS columns
       WHERE columns.name IN ('created_by', 'updated_by')
         AND columns."notnull" = 0
         AND NOT EXISTS (
           SELECT 1
           FROM pragma_foreign_key_list('scheduled_tasks') AS foreign_keys
           WHERE foreign_keys."from" = columns.name
             AND foreign_keys."table" = 'users'
         )`;

/** Params: [tableName]. */
export const TABLE_WITHOUT_ROWID_SQL = `SELECT instr(upper(sql), 'WITHOUT ROWID') > 0 AS withoutRowid
         FROM sqlite_schema WHERE type = 'table' AND name = ?`;

/** Params: [tableName]. */
export const TABLE_PRIMARY_KEY_SQL =
  "SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk";

/** Params: [replacementUserId | null, sourceUserId]. */
export function userReferenceRewriteSql(reference: UserReferenceRow): string {
  const table = quoteSqlIdentifier(reference.tableName);
  const column = quoteSqlIdentifier(reference.columnName);
  return `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`;
}

/**
 * Params: [replacementUserId | null, sourceUserId, limit]. `keyColumns` is
 * the batch key: rowid, or the primary key of a WITHOUT ROWID table.
 */
export function userReferenceBatchRewriteSql(
  reference: UserReferenceRow & { keyColumns: string[] },
): string {
  const table = quoteSqlIdentifier(reference.tableName);
  const column = quoteSqlIdentifier(reference.columnName);
  const keys = reference.keyColumns.map(quoteSqlIdentifier).join(", ");
  const keyTuple = reference.keyColumns.length === 1 ? keys : `(${keys})`;
  return `UPDATE ${table} SET ${column} = ?
     WHERE ${keyTuple} IN (SELECT ${keys} FROM ${table} WHERE ${column} = ? LIMIT ?)`;
}

/**
 * The requester a workflow run stores inside its JSON context. Migration 319
 * indexes this exact expression (idx_workflow_runs_context_requester), so the
 * statements below must use it verbatim: SQLite matches an expression index
 * only against an identical expression. The CASE guard keeps malformed JSON
 * out of json_extract, which would otherwise raise while the index is built.
 */
export const WORKFLOW_CONTEXT_REQUESTER_SQL =
  "CASE WHEN json_valid(context) THEN json_extract(context, '$.swarm.requestedByUserId') END";

/** Params: [sourceUserId]. */
export const WORKFLOW_SEALED_CONTEXT_BY_REQUESTER_SQL = `SELECT id, context_replay FROM workflow_runs
       WHERE ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?
         AND context_replay IS NOT NULL`;

/** Params: [replacementUserId, sourceUserId]. */
export const WORKFLOW_CONTEXT_SET_REQUESTER_SQL = `UPDATE workflow_runs
       SET context = json_set(context, '$.swarm.requestedByUserId', ?)
       WHERE ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?`;

/** Params: [sourceUserId]. */
export const WORKFLOW_CONTEXT_REMOVE_REQUESTER_SQL = `UPDATE workflow_runs
       SET context = json_remove(context, '$.swarm.requestedByUserId')
       WHERE ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?`;

/** Params: [sourceUserId, limit (-1 for none)]. Ordered by id. */
export const WORKFLOW_RUNS_REQUESTED_BY_SQL = `SELECT id FROM workflow_runs
     WHERE ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?
     ORDER BY id
     LIMIT ?`;

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

/** Params: [...runIds, sourceUserId]. */
export function sealedContextsOfRunsByRequesterSql(runCount: number): string {
  return `SELECT id, context_replay FROM workflow_runs
     WHERE id IN (${placeholders(runCount)})
       AND context_replay IS NOT NULL
       AND ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?`;
}

/** Params: [replacementUserId, ...runIds, sourceUserId]. */
export function setRunsContextRequesterSql(runCount: number): string {
  return `UPDATE workflow_runs
         SET context = json_set(context, '$.swarm.requestedByUserId', ?)
         WHERE id IN (${placeholders(runCount)})
           AND ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?`;
}

/** Params: [...runIds, sourceUserId]. */
export function removeRunsContextRequesterSql(runCount: number): string {
  return `UPDATE workflow_runs
         SET context = json_remove(context, '$.swarm.requestedByUserId')
         WHERE id IN (${placeholders(runCount)})
           AND ${WORKFLOW_CONTEXT_REQUESTER_SQL} = ?`;
}
