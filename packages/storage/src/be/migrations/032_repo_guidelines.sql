-- Add guidelines column to swarm_repos for per-repo quality checks, merge policy, and review guidance.
-- Stores a JSON string of { prChecks: string[], mergeChecks: string[], allowMerge?: boolean, review: string[] }.
-- NULL means "not yet configured" (lead should ask). Empty object with empty arrays means "explicitly no checks."
ALTER TABLE swarm_repos ADD COLUMN guidelines TEXT DEFAULT NULL;
