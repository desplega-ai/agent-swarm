-- 053_agent_waiting_for_credentials_status.sql
--
-- Phase 3 of the worker credential safe-loop plan
-- (thoughts/taras/plans/2026-05-06-worker-credential-safe-loop.md).
--
-- Extend the `agents.status` enum with `waiting_for_credentials` and add a
-- `credentialMissing` JSON column that carries the list of env-var names
-- the worker is blocked on. We extend the existing status axis rather than
-- adding a parallel column because:
--   - All four states live on the same "is this agent reachable AND
--     willing to claim work?" axis.
--   - The dispatcher's capacity predicate already filters by
--     `status === 'idle'`; the new value is implicitly excluded with no
--     code change.
--   - Avoids JOIN-or-AND-condition churn in every read site.
--
-- SQLite cannot ALTER a CHECK constraint in place, so we rebuild the table.

-- 1. Create the new table with the expanded CHECK and the new column.
CREATE TABLE agents_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    isLead INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL
      CHECK(status IN ('idle', 'busy', 'offline', 'waiting_for_credentials')),
    description TEXT,
    role TEXT,
    capabilities TEXT DEFAULT '[]',
    maxTasks INTEGER DEFAULT 1,
    emptyPollCount INTEGER DEFAULT 0,
    claudeMd TEXT,
    soulMd TEXT,
    identityMd TEXT,
    setupScript TEXT,
    toolsMd TEXT,
    lastActivityAt TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    heartbeatMd TEXT DEFAULT NULL,
    provider TEXT,
    credentialMissing TEXT
);

-- 2. Copy existing data. Enumerate columns explicitly so the new
--    `credentialMissing` slot picks up its column default (NULL) instead of
--    being filled by a positional shift if the source order ever drifts.
INSERT INTO agents_new (
    id, name, isLead, status, description, role, capabilities, maxTasks,
    emptyPollCount, claudeMd, soulMd, identityMd, setupScript, toolsMd,
    lastActivityAt, createdAt, lastUpdatedAt, heartbeatMd, provider
)
SELECT
    id, name, isLead, status, description, role, capabilities, maxTasks,
    emptyPollCount, claudeMd, soulMd, identityMd, setupScript, toolsMd,
    lastActivityAt, createdAt, lastUpdatedAt, heartbeatMd, provider
FROM agents;

-- 3. Drop old table + rename. Foreign keys referencing `agents.id`
--    survive the rename (SQLite resolves them by table name lookup).
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
