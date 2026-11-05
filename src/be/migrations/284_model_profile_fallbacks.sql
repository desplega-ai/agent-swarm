-- Model profiles, PR 3 (runbooks/model-tiers.md § Fallbacks on provider errors).

-- JSON array of profile names on the same harness, tried in order when a
-- provider error ends a task running on this profile. '[]' never hops.
ALTER TABLE model_profiles ADD COLUMN fallbacks TEXT NOT NULL DEFAULT '[]';

-- JSON array of the hops the work took so far ({from, profile, errorClass,
-- at, skipped?}); every resume of the same work carries it. NULL: no hop.
ALTER TABLE agent_tasks ADD COLUMN fallbackHops TEXT;
