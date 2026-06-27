-- Add opt-in hook installation config for worker repo setup.
-- Stores a JSON string of { enabled: boolean }. NULL means hooks are disabled.
ALTER TABLE swarm_repos ADD COLUMN hooks TEXT DEFAULT NULL;
