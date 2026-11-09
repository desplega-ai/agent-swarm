-- Model groups (runbooks/model-tiers.md § Model groups): a named, ordered list
-- of model profiles across harnesses. This migration only stores them; nothing
-- resolves a task through a group yet.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS model_groups (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  -- `tier:<tier>` for a boot seed (src/be/seed-model-groups.ts), NULL otherwise.
  seededFrom TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

-- One row per member; `position` is the order (0 first). A profile still in a
-- group cannot be deleted: deleteModelProfile checks it in the DELETE, and the
-- foreign key refuses any other path.
CREATE TABLE IF NOT EXISTS model_group_members (
  groupId TEXT NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  profileName TEXT NOT NULL REFERENCES model_profiles(name),
  PRIMARY KEY (groupId, position),
  UNIQUE (groupId, profileName)
);

CREATE INDEX IF NOT EXISTS idx_model_group_members_profile
  ON model_group_members(profileName);

ALTER TABLE agent_tasks ADD COLUMN modelGroup TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN modelGroup TEXT;

-- Same reference rule as migrations 220 and 281 for profiles: a task or a
-- schedule may only name a group that exists. The delete side is the matching
-- guard in deleteModelGroup (src/be/db/model-groups.ts).
CREATE TRIGGER IF NOT EXISTS model_groups_task_ref_insert
BEFORE INSERT ON agent_tasks
WHEN NEW.modelGroup IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_groups WHERE name = NEW.modelGroup)
BEGIN
  SELECT RAISE(ABORT, 'model-group-missing: the task''s model group does not exist');
END;

CREATE TRIGGER IF NOT EXISTS model_groups_task_ref_update
BEFORE UPDATE OF modelGroup ON agent_tasks
WHEN NEW.modelGroup IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_groups WHERE name = NEW.modelGroup)
BEGIN
  SELECT RAISE(ABORT, 'model-group-missing: the task''s model group does not exist');
END;

CREATE TRIGGER IF NOT EXISTS model_groups_schedule_ref_insert
BEFORE INSERT ON scheduled_tasks
WHEN NEW.modelGroup IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_groups WHERE name = NEW.modelGroup)
BEGIN
  SELECT RAISE(ABORT, 'model-group-missing: the schedule''s model group does not exist');
END;

CREATE TRIGGER IF NOT EXISTS model_groups_schedule_ref_update
BEFORE UPDATE OF modelGroup ON scheduled_tasks
WHEN NEW.modelGroup IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_groups WHERE name = NEW.modelGroup)
BEGIN
  SELECT RAISE(ABORT, 'model-group-missing: the schedule''s model group does not exist');
END;

-- One name space: a group may not take a profile's name, and the reverse, so
-- `smart` never means two things in a tool call or a log line. Names are fixed
-- after create, so only inserts need the check.
CREATE TRIGGER IF NOT EXISTS model_groups_name_space_insert
BEFORE INSERT ON model_groups
WHEN EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.name)
BEGIN
  SELECT RAISE(ABORT, 'model-name-taken: a model profile has this name');
END;

CREATE TRIGGER IF NOT EXISTS model_profiles_name_space_insert
BEFORE INSERT ON model_profiles
WHEN EXISTS (SELECT 1 FROM model_groups WHERE name = NEW.name)
BEGIN
  SELECT RAISE(ABORT, 'model-name-taken: a model group has this name');
END;
