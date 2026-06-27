CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    event TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    source TEXT NOT NULL,
    agentId TEXT,
    taskId TEXT,
    sessionId TEXT,
    parentEventId TEXT,
    numericValue REAL,
    durationMs INTEGER,
    data TEXT,
    createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_agentId ON events(agentId);
CREATE INDEX IF NOT EXISTS idx_events_taskId ON events(taskId);
CREATE INDEX IF NOT EXISTS idx_events_sessionId ON events(sessionId);
CREATE INDEX IF NOT EXISTS idx_events_createdAt ON events(createdAt);
