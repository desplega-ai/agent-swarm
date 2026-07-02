-- Skills table: stores skill definitions
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',

  -- Type & ownership
  type TEXT NOT NULL DEFAULT 'personal'
    CHECK (type IN ('remote', 'personal')),
  scope TEXT NOT NULL DEFAULT 'agent'
    CHECK (scope IN ('global', 'swarm', 'agent')),
  ownerAgentId TEXT,

  -- Remote skill metadata
  sourceUrl TEXT,
  sourceRepo TEXT,
  sourcePath TEXT,
  sourceBranch TEXT DEFAULT 'main',
  sourceHash TEXT,
  isComplex INTEGER DEFAULT 0,

  -- Parsed frontmatter cache (denormalized)
  allowedTools TEXT,
  model TEXT,
  effort TEXT,
  context TEXT,
  agent TEXT,
  disableModelInvocation INTEGER DEFAULT 0,
  userInvocable INTEGER DEFAULT 1,

  -- Metadata
  version INTEGER NOT NULL DEFAULT 1,
  isEnabled INTEGER NOT NULL DEFAULT 1,

  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  lastFetchedAt TEXT,

  FOREIGN KEY (ownerAgentId) REFERENCES agents(id)
);

-- Unique constraint: name must be unique within scope+owner combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name_scope
  ON skills(name, scope, COALESCE(ownerAgentId, ''));

CREATE INDEX IF NOT EXISTS idx_skills_type ON skills(type);
CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope);
CREATE INDEX IF NOT EXISTS idx_skills_owner ON skills(ownerAgentId);

-- Agent-skill junction table
CREATE TABLE IF NOT EXISTS agent_skills (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  skillId TEXT NOT NULL,
  isActive INTEGER NOT NULL DEFAULT 1,
  installedAt TEXT NOT NULL,

  FOREIGN KEY (agentId) REFERENCES agents(id),
  FOREIGN KEY (skillId) REFERENCES skills(id) ON DELETE CASCADE,
  UNIQUE(agentId, skillId)
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agentId);
CREATE INDEX IF NOT EXISTS idx_agent_skills_skill ON agent_skills(skillId);
