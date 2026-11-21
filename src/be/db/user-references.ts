/**
 * SQL that deleteUser runs to move or clear every reference to a user.
 *
 * The statement texts live in the SQLite storage package (the users
 * repository runs the same texts for the merge job); these names stay so
 * deleteUser and the query-plan test (src/tests/user-delete-perf.test.ts)
 * use the exact SQL that production executes. Incident 2026-11-09: a user
 * merge ran these statements as full table scans on an 85 GB database and
 * blocked the API for 278 s. WORKFLOW_CONTEXT_REQUESTER_SQL is the expression
 * migration 319 indexes (idx_workflow_runs_context_requester), byte for byte.
 */

export type { UserReferenceRow } from "@desplega/storage";
export {
  quoteSqlIdentifier,
  USER_REFERENCE_COLUMNS_SQL,
  userReferenceRewriteSql,
  WORKFLOW_CONTEXT_REMOVE_REQUESTER_SQL,
  WORKFLOW_CONTEXT_REQUESTER_SQL,
  WORKFLOW_CONTEXT_SET_REQUESTER_SQL,
  WORKFLOW_SEALED_CONTEXT_BY_REQUESTER_SQL,
} from "../storage-root";
