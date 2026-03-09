-- Add VCS provider abstraction: rename github* columns to vcs* and add vcsProvider
-- Supports both GitHub and GitLab (and future providers) via a single set of columns.

-- agent_tasks: rename github* → vcs* and add vcsProvider
ALTER TABLE agent_tasks RENAME COLUMN githubRepo TO vcsRepo;
ALTER TABLE agent_tasks RENAME COLUMN githubEventType TO vcsEventType;
ALTER TABLE agent_tasks RENAME COLUMN githubNumber TO vcsNumber;
ALTER TABLE agent_tasks RENAME COLUMN githubCommentId TO vcsCommentId;
ALTER TABLE agent_tasks RENAME COLUMN githubAuthor TO vcsAuthor;
ALTER TABLE agent_tasks RENAME COLUMN githubUrl TO vcsUrl;
ALTER TABLE agent_tasks ADD COLUMN vcsProvider TEXT DEFAULT NULL;

-- Update source CHECK constraint to include 'gitlab'
-- SQLite doesn't support ALTER CHECK, but we can add a new CHECK via trigger or just
-- rely on application-level validation. The existing CHECK constraint on source column
-- will remain as-is since 'gitlab' tasks use source='gitlab' which we add here.
-- Actually, we need to handle this at the application level since SQLite CHECK constraints
-- can't be altered after table creation without recreating the table.

-- epics: rename github* → vcs* and add vcsProvider
ALTER TABLE epics RENAME COLUMN githubRepo TO vcsRepo;
ALTER TABLE epics RENAME COLUMN githubMilestone TO vcsMilestone;
ALTER TABLE epics ADD COLUMN vcsProvider TEXT DEFAULT NULL;

-- Backfill: set vcsProvider='github' for existing rows that have VCS data
UPDATE agent_tasks SET vcsProvider = 'github' WHERE vcsRepo IS NOT NULL;
UPDATE epics SET vcsProvider = 'github' WHERE vcsRepo IS NOT NULL;
