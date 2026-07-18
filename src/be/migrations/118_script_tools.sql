-- 118_script_tools.sql
-- Extension system, Layer 3: publish a global catalog script as an
-- agent-visible MCP tool. Rows are read at MCP server creation time
-- (per-session), so newly published tools appear on the next session.

CREATE TABLE IF NOT EXISTS script_tools (
    id TEXT PRIMARY KEY,
    toolName TEXT NOT NULL UNIQUE,
    scriptName TEXT NOT NULL,
    description TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdByAgentId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_script_tools_enabled ON script_tools(enabled);
