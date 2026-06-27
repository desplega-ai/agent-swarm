-- Migration 087: skill_files table for complex (multi-file) skills.
-- Additive only: simple skills have zero rows and existing behavior is unchanged.

CREATE TABLE IF NOT EXISTS skill_files (
  id TEXT PRIMARY KEY,
  skillId TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  mimeType TEXT NOT NULL DEFAULT 'text/plain',
  isBinary INTEGER NOT NULL DEFAULT 0,
  size INTEGER,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE(skillId, path)
);

CREATE INDEX IF NOT EXISTS idx_skill_files_skill ON skill_files(skillId);
