-- 080_skill_system_defaults.sql
-- Adds a first-class marker for skills that are installed for every agent.
-- Forward migration: add nullable-safe column with default 0.
-- Reverse operation, if ever needed: ALTER TABLE skills DROP COLUMN systemDefault;

ALTER TABLE skills ADD COLUMN systemDefault INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_skills_system_default ON skills(systemDefault);
