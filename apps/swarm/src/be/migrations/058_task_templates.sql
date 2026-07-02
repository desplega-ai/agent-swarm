-- Task templates — "To start" bucket starters. Polymorphic from day one
-- (kind = 'task' | 'workflow' | 'schedule') so v2 can register workflow /
-- schedule starters without a follow-up migration. v1 only inserts/reads
-- kind='task' rows; the schema is shaped for v2.
--
-- The `prompt` column is NOT NULL only because v1 only ever seeds task rows;
-- a future migration can relax that when workflow/schedule starters land
-- (workflows carry workflowId in `payload`, schedules carry cron + prompt).
--
-- Table name kept as `task_templates` for v1 to match existing references
-- across the plan; v2 may rename to `quick_starts` if non-task kinds graduate.
CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','workflow','schedule')),
  payload TEXT NOT NULL DEFAULT '{}',
  category TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_templates_kind ON task_templates(kind);

INSERT INTO task_templates (title, description, prompt, category, tags) VALUES
  ('Refactor a file', 'Improve a file without changing behavior', 'Refactor the file at <path> for readability while preserving behavior. Run typecheck + tests after.', 'engineering', '["refactor"]'),
  ('Investigate a bug', 'Reproduce, root-cause, and propose a fix', 'Investigate the following bug: <symptom>. Reproduce locally, identify the root cause, and propose a fix.', 'engineering', '["debug"]'),
  ('Open a PR', 'Create a PR for the current branch', 'Open a PR from the current branch with a clear summary and test plan.', 'git', '["git","pr"]'),
  ('Write tests for X', 'Cover an under-tested module', 'Write unit tests for <module>. Aim for ~80% line coverage.', 'engineering', '["test"]'),
  ('Daily triage', 'Review failed tasks + pending approvals', 'Triage the action-items inbox: dismiss noise, escalate blockers, summarize unread sessions.', 'ops', '["triage"]');
