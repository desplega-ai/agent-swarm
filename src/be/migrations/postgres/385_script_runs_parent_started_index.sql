-- A run tree reads one level per query: children of the frontier, LIMITed and
-- ordered by (parent, start time, id). This index returns them in that order,
-- so the read stops at the LIMIT instead of sorting every child of a wide level.
-- It replaces the parent-only index, which it covers as a prefix.
DROP INDEX IF EXISTS "idx_script_runs_parentScriptRunId";
CREATE INDEX IF NOT EXISTS "idx_script_runs_parent_started"
  ON "script_runs" ("parentScriptRunId", "startedAt", id) WHERE "parentScriptRunId" IS NOT NULL;
