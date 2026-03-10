-- Event prompt templates: configurable prompts for external event sources (GitHub, GitLab, AgentMail)
CREATE TABLE IF NOT EXISTS event_prompt_templates (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('github', 'gitlab', 'agentmail')),
  eventType TEXT NOT NULL,
  template TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  agentId TEXT,
  description TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, eventType, agentId)
);

CREATE INDEX IF NOT EXISTS idx_event_prompt_templates_lookup
  ON event_prompt_templates(provider, eventType, enabled);
