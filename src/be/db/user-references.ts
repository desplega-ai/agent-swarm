/**
 * SQL that deleteUser runs to move or clear every reference to a user.
 *
 * The statements live here, not inline in deleteUser, so the query-plan test
 * (src/tests/user-delete-perf.test.ts) explains the exact SQL that production
 * executes. Incident 2026-11-09: a user merge ran these statements as full
 * table scans on an 85 GB database and blocked the API for 278 s.
 */

export type UserReferenceRow = {
  tableName: string;
  columnName: string;
};

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

/** Params: [replacementUserId | null, sourceUserId]. */
export function userReferenceRewriteSql(reference: UserReferenceRow): string {
  const table = quoteSqlIdentifier(reference.tableName);
  const column = quoteSqlIdentifier(reference.columnName);
  return `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`;
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
