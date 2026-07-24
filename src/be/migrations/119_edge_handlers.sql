-- 119_edge_handlers.sql
-- Task lifecycle routing, Phase 2: persisted registration catalog only.
-- Execution and tracing are intentionally introduced in later phases.

CREATE TABLE IF NOT EXISTS edge_handlers (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    edge TEXT NOT NULL CHECK (edge IN ('task.before_assign', 'prompt.compose')),
    scriptName TEXT NOT NULL,
    description TEXT,
    flavor TEXT NOT NULL CHECK (flavor IN ('route', 'guard')),
    mode TEXT NOT NULL CHECK (mode IN ('soft', 'hard')),
    priority INTEGER NOT NULL DEFAULT 100,
    matcher TEXT,
    timeoutMs INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdByAgentId TEXT,
    created_by TEXT,
    updated_by TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_edge_handlers_edge_enabled
    ON edge_handlers(edge, enabled);
