-- 013_prompt_templates.sql
-- Prompt Template Registry: per-event customizable prompt templates with scope resolution,
-- three-state behavior, wildcard matching, and version history.

CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY,
    eventType TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
    scopeId TEXT,
    state TEXT NOT NULL DEFAULT 'enabled' CHECK(state IN ('enabled', 'default_prompt_fallback', 'skip_event')),
    body TEXT NOT NULL,
    isDefault INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    createdBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(eventType, scope, scopeId)
);

CREATE TABLE IF NOT EXISTS prompt_template_history (
    id TEXT PRIMARY KEY,
    templateId TEXT NOT NULL,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    changedBy TEXT,
    changedAt TEXT NOT NULL,
    changeReason TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_event_type ON prompt_templates(eventType);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_scope ON prompt_templates(scope, scopeId);
CREATE INDEX IF NOT EXISTS idx_prompt_template_history_template ON prompt_template_history(templateId);
