-- Model profiles, PR 2 (runbooks/model-tiers.md § Model profiles).
PRAGMA defer_foreign_keys = ON;

-- JSON {VAR: [suffix, ...]}: the last 5 characters of each pooled key the
-- profile may use, per credential var. NULL means the whole pool.
ALTER TABLE model_profiles ADD COLUMN credentialAllowlist TEXT;

-- A schedule's profile is copied onto every task it fires.
ALTER TABLE scheduled_tasks ADD COLUMN profile TEXT;

-- Same reference rule as migration 220's agent_tasks triggers: a schedule may
-- only name a profile that exists. The delete side is the matching guard in
-- deleteModelProfile (src/be/db/model-profiles.ts).
CREATE TRIGGER IF NOT EXISTS model_profiles_schedule_ref_insert
BEFORE INSERT ON scheduled_tasks
WHEN NEW.profile IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.profile)
BEGIN
  SELECT RAISE(ABORT, 'model-profile-missing: the schedule''s model profile does not exist');
END;

CREATE TRIGGER IF NOT EXISTS model_profiles_schedule_ref_update
BEFORE UPDATE OF profile ON scheduled_tasks
WHEN NEW.profile IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.profile)
BEGIN
  SELECT RAISE(ABORT, 'model-profile-missing: the schedule''s model profile does not exist');
END;
