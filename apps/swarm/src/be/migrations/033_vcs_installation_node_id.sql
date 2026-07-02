-- Add GitHub installation ID and GraphQL node ID to tasks
-- Needed for adding reactions (eyes emoji) when agents pick up GitHub-sourced tasks
ALTER TABLE agent_tasks ADD COLUMN vcsInstallationId INTEGER;
ALTER TABLE agent_tasks ADD COLUMN vcsNodeId TEXT;
