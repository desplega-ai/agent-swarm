-- Intent rows for side-effecting tool calls. A worker's PreToolUse hook writes
-- one before the call runs and its PostToolUse hook deletes it, so a row that
-- survives marks a call a hard kill may have cut mid-flight. session_logs
-- flush on a 5 s timer, so this is the only record of a call killed inside
-- that window. The resume preamble reads it next to session_logs.
CREATE TABLE IF NOT EXISTS tool_call_intents (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    agentId TEXT,
    toolCallId TEXT NOT NULL,
    toolName TEXT NOT NULL,
    argsSummary TEXT,
    createdAt TEXT NOT NULL,
    UNIQUE (taskId, toolCallId)
);
