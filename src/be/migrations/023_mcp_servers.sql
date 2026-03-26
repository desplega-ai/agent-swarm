-- MCP server definitions
CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'swarm', 'agent')),
    ownerAgentId TEXT REFERENCES agents(id),
    transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'sse')),
    -- Stdio fields
    command TEXT,
    args TEXT,          -- JSON array string
    -- HTTP/SSE fields
    url TEXT,
    headers TEXT,       -- JSON object string (non-secret headers only)
    -- Secret references (keys in swarm_config, NOT actual values)
    envConfigKeys TEXT,     -- JSON object: {"ENV_VAR": "config-key-name"}
    headerConfigKeys TEXT,  -- JSON object: {"Header-Name": "config-key-name"}
    -- Metadata
    isEnabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL
);

-- Unique constraint: name must be unique within scope+owner combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name_scope
  ON mcp_servers(name, scope, COALESCE(ownerAgentId, ''));

CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers(ownerAgentId);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_transport ON mcp_servers(transport);

-- Per-agent MCP server installation
CREATE TABLE IF NOT EXISTS agent_mcp_servers (
    id TEXT PRIMARY KEY,
    agentId TEXT NOT NULL REFERENCES agents(id),
    mcpServerId TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    isActive INTEGER NOT NULL DEFAULT 1,
    installedAt TEXT NOT NULL,
    UNIQUE(agentId, mcpServerId)
);

CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_agent ON agent_mcp_servers(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_server ON agent_mcp_servers(mcpServerId);
