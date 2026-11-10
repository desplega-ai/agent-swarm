-- Request composition manifest: what each LLM call's prompt is made of.
-- One row per session (seq 0), plus a new seq only when the static parts
-- change. Each part carries chars, an estimated token count and a fidelity.
-- Message history and the harness's own base prompt are derived at read time
-- from per-call usage in session_logs, so they are not stored here.
CREATE TABLE IF NOT EXISTS request_composition (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    sessionId TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL,
    model TEXT,
    source TEXT NOT NULL CHECK (source IN ('worker', 'harness-hook')),
    parts TEXT NOT NULL,
    staticEstTokens INTEGER NOT NULL,
    tokenRatio REAL NOT NULL DEFAULT 1.0,
    createdAt TEXT NOT NULL,
    UNIQUE (sessionId, seq)
);

CREATE INDEX IF NOT EXISTS idx_request_composition_task ON request_composition(taskId);
