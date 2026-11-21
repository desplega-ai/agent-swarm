import { type DbParam, KEY_WINDOW_USAGE_MAX_ROWS, SqlQuery } from "@desplega/storage";

// The statement text is exported for the query-plan test
// (src/tests/key-window-usage.test.ts), which EXPLAINs and matches the exact
// text the sessions repository runs.

const usageColumns = `sc.taskId, sc.credentialKeyType, sc.credentialKeySuffix, sc.harness,
  sc.inputTokens, sc.outputTokens, sc.cacheReadTokens, sc.cacheWriteTokens,
  sc.reasoningOutputTokens, sc.thinkingTokens, sc.model, sc.modelBreakdown,
  sc.isError, sc.createdAt`;

// Receipt rows and older completion-attribution rows are disjoint.
// Drive older rows from recent task completions, never the credential's entire history.
export const KEY_WINDOW_USAGE_SQL = `
  WITH requested_keys AS (
    SELECT json_extract(value, '$.keyType') AS keyType,
      json_extract(value, '$.keySuffix') AS keySuffix FROM json_each(?)
  )
  SELECT ${usageColumns}, CASE WHEN t.status = 'completed' THEN t.finishedAt END AS finishedAt
  FROM requested_keys k
  JOIN session_costs sc INDEXED BY idx_session_costs_credential_createdAt
    ON sc.credentialKeyType = k.keyType AND sc.credentialKeySuffix = k.keySuffix
  LEFT JOIN agent_tasks t ON t.id = sc.taskId
  WHERE sc.createdAt >= ? AND sc.createdAt < ?
  UNION ALL
  SELECT ${usageColumns}, t.finishedAt
  FROM agent_tasks t INDEXED BY idx_agent_tasks_status_finishedAt
  CROSS JOIN session_costs sc INDEXED BY idx_session_costs_taskId ON sc.taskId = t.id
  JOIN requested_keys k ON sc.credentialKeyType = k.keyType AND sc.credentialKeySuffix = k.keySuffix
  WHERE t.status = 'completed' AND t.finishedAt >= ? AND t.finishedAt < ? AND sc.createdAt < ?
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, 0, 0, '', NULL, 0, sc.createdAt, NULL
  FROM session_costs sc
  WHERE (sc.credentialKeyType IS NULL OR sc.credentialKeySuffix IS NULL)
    AND sc.kind = 'harness'
    AND sc.createdAt >= ? AND sc.createdAt < ?
  LIMIT ${KEY_WINDOW_USAGE_MAX_ROWS + 1}`;

/** The statement as a query whose rendered text is exactly `KEY_WINDOW_USAGE_SQL`. */
export function keyWindowUsageQuery(
  credentials: { keyType: string; keySuffix: string }[],
  start: string,
  through: string,
): SqlQuery {
  const values: DbParam[] = [
    JSON.stringify(credentials),
    start,
    through,
    start,
    through,
    start,
    start,
    through,
  ];
  const strings = KEY_WINDOW_USAGE_SQL.split("?");
  if (strings.length !== values.length + 1) throw new Error("placeholder count mismatch");
  return new SqlQuery(strings, values);
}
