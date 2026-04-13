-- Progressive context usage snapshots
CREATE TABLE IF NOT EXISTS task_context_snapshots (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    sessionId TEXT NOT NULL,

    -- Context window state
    contextUsedTokens INTEGER,
    contextTotalTokens INTEGER,
    contextPercent REAL,

    -- Event metadata
    eventType TEXT NOT NULL CHECK (eventType IN ('progress', 'compaction', 'completion')),

    -- Compaction-specific (NULL for non-compaction)
    compactTrigger TEXT CHECK (compactTrigger IN ('auto', 'manual') OR compactTrigger IS NULL),
    preCompactTokens INTEGER,

    -- Cumulative counters at this point
    cumulativeInputTokens INTEGER DEFAULT 0,
    cumulativeOutputTokens INTEGER DEFAULT 0,

    createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_task ON task_context_snapshots(taskId);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_session ON task_context_snapshots(sessionId);

-- Aggregate columns on agent_tasks
ALTER TABLE agent_tasks ADD COLUMN compactionCount INTEGER DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN peakContextPercent REAL;
ALTER TABLE agent_tasks ADD COLUMN totalContextTokensUsed INTEGER;
ALTER TABLE agent_tasks ADD COLUMN contextWindowSize INTEGER;
