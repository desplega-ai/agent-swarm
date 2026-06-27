-- Add optional workspace fields to workflows
ALTER TABLE workflows ADD COLUMN dir TEXT;
ALTER TABLE workflows ADD COLUMN vcs_repo TEXT;
