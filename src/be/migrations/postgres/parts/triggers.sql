-- Hand-written Postgres ports of the SQLite head-schema triggers (decision D9).
-- One plpgsql trigger function and one trigger per SQLite trigger, with the
-- same name and the same rule. The generator appends this file to the
-- baseline; edit it here, then run scripts/storage/generate-postgres-baseline.ts.
--
-- Port rules:
-- - SQLite `WHEN <cond>` becomes `IF <cond>` in the function (a Postgres
--   trigger WHEN clause cannot hold a subquery). A NULL condition does not fire
--   on either engine.
-- - `RAISE(ABORT, 'msg')` becomes `RAISE EXCEPTION 'msg'` with the same text.
-- - A BEFORE trigger returns NEW (OLD for DELETE) so the row proceeds; an AFTER
--   trigger returns NULL.
-- - Flags are boolean (`= false`, `= true`); timestamps are timestamptz, so a
--   clock value is statement_timestamp() (SQLite 'now' is fixed per statement).
-- - `INSERT OR IGNORE` becomes `ON CONFLICT DO NOTHING`; `INSERT OR REPLACE`
--   becomes `ON CONFLICT (<primary key>) DO UPDATE` of every column (each
--   statement here lists every column, so REPLACE's delete+insert is the same
--   row).
-- - `a IS NOT b` on values becomes `IS DISTINCT FROM`; scalar `MAX(a, b)`
--   (NULL when either is NULL) becomes a CASE around GREATEST.
-- - `GLOB 'p*'` becomes `LIKE 'p%'` (both case-sensitive; the prefixes hold no
--   LIKE wildcard).
--
-- Not here: the 9 FTS sync triggers (agent_tasks_fts_*, skills_fts_*,
-- skills_meta_fts_*). They write the FTS5 tables, which the baseline leaves
-- out; full-text search on Postgres is milestone M4 (see
-- scripts/storage-checks/schema-parity-allowlist.txt).

-- ---------------------------------------------------------------------------
-- Asset keys (15)
-- ---------------------------------------------------------------------------

-- The shared rule of the 14 validate_* triggers. Checked step by step:
-- Postgres does not promise left-to-right evaluation of OR/AND, and the
-- personal/<user>/ lookup must not run on a key that failed the shape checks.
-- SQLite's `instr(key, char(0)) > 0` test has no port: Postgres text cannot
-- hold a NUL byte.
CREATE FUNCTION asset_key_is_invalid(k text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  rest text;
BEGIN
  IF k IS NULL
    OR length(k) = 0
    OR k <> trim(k)
    OR length(k) > 255
    OR right(k, 1) <> '/'
    OR strpos(k, chr(92)) > 0
    OR strpos(k, '//') > 0
    OR strpos(k, '/../') > 0
    OR strpos(k, '/./') > 0
    OR k <> lower(k) THEN
    RETURN true;
  END IF;
  IF k = 'shared/' OR k ILIKE 'shared/%' THEN
    RETURN false;
  END IF;
  IF k ILIKE 'personal/%/%' THEN
    rest := substr(k, 10);
    IF EXISTS (SELECT 1 FROM users WHERE id = substr(rest, 1, strpos(rest, '/') - 1)) THEN
      RETURN false;
    END IF;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION validate_agent_tasks_asset_key_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_agent_tasks_asset_key_insert BEFORE INSERT ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION validate_agent_tasks_asset_key_insert();

CREATE FUNCTION validate_agent_tasks_asset_key_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_agent_tasks_asset_key_update BEFORE UPDATE OF "key" ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION validate_agent_tasks_asset_key_update();

CREATE FUNCTION validate_pages_asset_key_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_pages_asset_key_insert BEFORE INSERT ON pages
FOR EACH ROW EXECUTE FUNCTION validate_pages_asset_key_insert();

CREATE FUNCTION validate_pages_asset_key_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_pages_asset_key_update BEFORE UPDATE OF "key" ON pages
FOR EACH ROW EXECUTE FUNCTION validate_pages_asset_key_update();

CREATE FUNCTION validate_apps_asset_key_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_apps_asset_key_insert BEFORE INSERT ON apps
FOR EACH ROW EXECUTE FUNCTION validate_apps_asset_key_insert();

CREATE FUNCTION validate_apps_asset_key_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_apps_asset_key_update BEFORE UPDATE OF "key" ON apps
FOR EACH ROW EXECUTE FUNCTION validate_apps_asset_key_update();

CREATE FUNCTION validate_scripts_asset_key_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_scripts_asset_key_insert BEFORE INSERT ON scripts
FOR EACH ROW EXECUTE FUNCTION validate_scripts_asset_key_insert();

CREATE FUNCTION validate_scripts_asset_key_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_scripts_asset_key_update BEFORE UPDATE OF "key" ON scripts
FOR EACH ROW EXECUTE FUNCTION validate_scripts_asset_key_update();

CREATE FUNCTION validate_scheduled_tasks_asset_key_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_scheduled_tasks_asset_key_insert BEFORE INSERT ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION validate_scheduled_tasks_asset_key_insert();

CREATE FUNCTION validate_scheduled_tasks_asset_key_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_scheduled_tasks_asset_key_update BEFORE UPDATE OF "key" ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION validate_scheduled_tasks_asset_key_update();

CREATE FUNCTION validate_workflows_asset_key_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_workflows_asset_key_insert BEFORE INSERT ON workflows
FOR EACH ROW EXECUTE FUNCTION validate_workflows_asset_key_insert();

CREATE FUNCTION validate_workflows_asset_key_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset namespace key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_workflows_asset_key_update BEFORE UPDATE OF "key" ON workflows
FOR EACH ROW EXECUTE FUNCTION validate_workflows_asset_key_update();

CREATE FUNCTION validate_asset_key_mappings_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_id = '' OR NEW.provider_key = '' OR asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset key mapping';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_asset_key_mappings_insert BEFORE INSERT ON asset_key_mappings
FOR EACH ROW EXECUTE FUNCTION validate_asset_key_mappings_insert();

CREATE FUNCTION validate_asset_key_mappings_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_id = '' OR NEW.provider_key = '' OR asset_key_is_invalid(NEW."key") THEN
    RAISE EXCEPTION 'invalid asset key mapping';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_asset_key_mappings_update BEFORE UPDATE ON asset_key_mappings
FOR EACH ROW EXECUTE FUNCTION validate_asset_key_mappings_update();

CREATE FUNCTION detach_asset_key_mapping_before_attachment_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE asset_key_mappings
  SET source_entity_type = 'external',
      source_entity_id = NULL,
      updated_at = statement_timestamp()
  WHERE source_entity_type = 'task-attachment'
    AND source_entity_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER detach_asset_key_mapping_before_attachment_delete BEFORE DELETE ON task_attachments
FOR EACH ROW EXECUTE FUNCTION detach_asset_key_mapping_before_attachment_delete();

-- ---------------------------------------------------------------------------
-- Model profiles and groups (12)
-- ---------------------------------------------------------------------------

CREATE FUNCTION model_profiles_name_space_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM model_groups WHERE name = NEW.name) THEN
    RAISE EXCEPTION 'model-name-taken: a model group has this name';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_name_space_insert BEFORE INSERT ON model_profiles
FOR EACH ROW EXECUTE FUNCTION model_profiles_name_space_insert();

CREATE FUNCTION model_groups_name_space_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.name) THEN
    RAISE EXCEPTION 'model-name-taken: a model profile has this name';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_groups_name_space_insert BEFORE INSERT ON model_groups
FOR EACH ROW EXECUTE FUNCTION model_groups_name_space_insert();

CREATE FUNCTION model_profiles_task_ref_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.profile IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.profile) THEN
    RAISE EXCEPTION 'model-profile-missing: the task''s model profile does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_task_ref_insert BEFORE INSERT ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION model_profiles_task_ref_insert();

CREATE FUNCTION model_profiles_task_ref_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.profile IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.profile) THEN
    RAISE EXCEPTION 'model-profile-missing: the task''s model profile does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_task_ref_update BEFORE UPDATE OF profile ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION model_profiles_task_ref_update();

CREATE FUNCTION model_groups_task_ref_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."modelGroup" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model_groups WHERE name = NEW."modelGroup") THEN
    RAISE EXCEPTION 'model-group-missing: the task''s model group does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_groups_task_ref_insert BEFORE INSERT ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION model_groups_task_ref_insert();

CREATE FUNCTION model_groups_task_ref_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."modelGroup" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model_groups WHERE name = NEW."modelGroup") THEN
    RAISE EXCEPTION 'model-group-missing: the task''s model group does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_groups_task_ref_update BEFORE UPDATE OF "modelGroup" ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION model_groups_task_ref_update();

CREATE FUNCTION model_profiles_schedule_ref_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.profile IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.profile) THEN
    RAISE EXCEPTION 'model-profile-missing: the schedule''s model profile does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_schedule_ref_insert BEFORE INSERT ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION model_profiles_schedule_ref_insert();

CREATE FUNCTION model_profiles_schedule_ref_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.profile IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.profile) THEN
    RAISE EXCEPTION 'model-profile-missing: the schedule''s model profile does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_schedule_ref_update BEFORE UPDATE OF profile ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION model_profiles_schedule_ref_update();

CREATE FUNCTION model_groups_schedule_ref_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."modelGroup" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model_groups WHERE name = NEW."modelGroup") THEN
    RAISE EXCEPTION 'model-group-missing: the schedule''s model group does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_groups_schedule_ref_insert BEFORE INSERT ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION model_groups_schedule_ref_insert();

CREATE FUNCTION model_groups_schedule_ref_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."modelGroup" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model_groups WHERE name = NEW."modelGroup") THEN
    RAISE EXCEPTION 'model-group-missing: the schedule''s model group does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_groups_schedule_ref_update BEFORE UPDATE OF "modelGroup" ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION model_groups_schedule_ref_update();

CREATE FUNCTION model_profiles_default_ref_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope = 'agent' AND NEW.key = 'MODEL_PROFILE'
    AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = trim(NEW.value)) THEN
    RAISE EXCEPTION 'model-profile-missing: the agent''s default model profile does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_default_ref_insert BEFORE INSERT ON swarm_config
FOR EACH ROW EXECUTE FUNCTION model_profiles_default_ref_insert();

CREATE FUNCTION model_profiles_default_ref_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope = 'agent' AND NEW.key = 'MODEL_PROFILE'
    AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = trim(NEW.value)) THEN
    RAISE EXCEPTION 'model-profile-missing: the agent''s default model profile does not exist';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_profiles_default_ref_update BEFORE UPDATE OF scope, key, value ON swarm_config
FOR EACH ROW EXECUTE FUNCTION model_profiles_default_ref_update();

-- ---------------------------------------------------------------------------
-- Session maintenance (14)
-- ---------------------------------------------------------------------------

-- session_summary_recompute is a view; an INSERT of a rootId recomputes that
-- session's summary row (INSTEAD OF trigger, as on SQLite).
CREATE FUNCTION session_summary_recompute_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE session_summaries SET
    "chainCount" = (SELECT COUNT(*) FROM session_members m WHERE m."rootId" = NEW."rootId"),
    "lastActivityAt" = (SELECT MAX(t."lastUpdatedAt") FROM session_members m
      JOIN agent_tasks t ON t.id = m."taskId" WHERE m."rootId" = NEW."rootId"),
    "latestStatus" = (SELECT t.status FROM session_members m
      JOIN agent_tasks t ON t.id = m."taskId" WHERE m."rootId" = NEW."rootId"
      ORDER BY t."lastUpdatedAt" DESC LIMIT 1),
    "pendingApprovalCount" = (SELECT COUNT(*) FROM session_members m
      JOIN approval_requests ar ON ar."sourceTaskId" = m."taskId"
      WHERE m."rootId" = NEW."rootId" AND ar.status = 'pending'),
    "openTaskCount" = (SELECT COUNT(*) FROM session_members m
      JOIN agent_tasks t ON t.id = m."taskId" WHERE m."rootId" = NEW."rootId"
      AND t.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')),
    "lastHumanAt" = (SELECT MAX(at) FROM (
      SELECT t."createdAt" AS at FROM session_members m JOIN agent_tasks t ON t.id = m."taskId"
      WHERE m."rootId" = NEW."rootId" AND t."requestedByUserId" IS NOT NULL
        AND t."requestedByUserIdInherited" = false
        AND COALESCE(t.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
      UNION ALL
      SELECT sm.created_at FROM session_members m
      JOIN task_steering_messages sm ON sm.task_id = m."taskId"
      WHERE m."rootId" = NEW."rootId" AND sm.created_by_kind = 'user' AND sm.status <> 'cancelled'
      UNION ALL
      SELECT ar."createdAt" FROM session_members m
      JOIN approval_requests ar ON ar."sourceTaskId" = m."taskId"
      WHERE m."rootId" = NEW."rootId" AND ar.status = 'pending') human)
  WHERE "rootId" = NEW."rootId"
    AND EXISTS (SELECT 1 FROM agent_tasks WHERE id = NEW."rootId");
  RETURN NEW;
END $$;
CREATE TRIGGER session_summary_recompute_apply INSTEAD OF INSERT ON session_summary_recompute
FOR EACH ROW EXECUTE FUNCTION session_summary_recompute_apply();

CREATE FUNCTION session_task_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO session_members ("taskId", "rootId")
  SELECT member."taskId", member."rootId" FROM (
    SELECT NEW.id AS "taskId", NEW.id AS "rootId" WHERE NEW."parentTaskId" IS NULL
    UNION ALL
    SELECT NEW.id, m."rootId" FROM session_members m WHERE m."taskId" = NEW."parentTaskId"
  ) member
  ON CONFLICT ("taskId") DO UPDATE SET "rootId" = EXCLUDED."rootId";

  IF NEW."parentTaskId" IS NULL THEN
    INSERT INTO session_summaries ("rootId", "createdAt", source, "key", "requestedByUserId",
      "scheduleId", "taskType", "slackChannelId", "contextKey", "chainCount", "lastActivityAt",
      "latestStatus", "pendingApprovalCount", "openTaskCount", "lastHumanAt")
    VALUES (NEW.id, NEW."createdAt", NEW.source, NEW."key", NEW."requestedByUserId",
      NEW."scheduleId", NEW."taskType", NEW."slackChannelId", NEW."contextKey", 1,
      NEW."lastUpdatedAt", NEW.status, 0,
      (NEW.status NOT IN ('completed', 'failed', 'cancelled', 'superseded'))::int,
      CASE WHEN NEW."requestedByUserId" IS NOT NULL AND NEW."requestedByUserIdInherited" = false
        AND COALESCE(NEW.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
        THEN NEW."createdAt" END)
    ON CONFLICT ("rootId") DO UPDATE SET
      "createdAt" = EXCLUDED."createdAt", source = EXCLUDED.source, "key" = EXCLUDED."key",
      "requestedByUserId" = EXCLUDED."requestedByUserId", "scheduleId" = EXCLUDED."scheduleId",
      "taskType" = EXCLUDED."taskType", "slackChannelId" = EXCLUDED."slackChannelId",
      "contextKey" = EXCLUDED."contextKey", "chainCount" = EXCLUDED."chainCount",
      "lastActivityAt" = EXCLUDED."lastActivityAt", "latestStatus" = EXCLUDED."latestStatus",
      "pendingApprovalCount" = EXCLUDED."pendingApprovalCount",
      "openTaskCount" = EXCLUDED."openTaskCount", "lastHumanAt" = EXCLUDED."lastHumanAt";
  END IF;

  IF NEW."parentTaskId" IS NOT NULL THEN
    UPDATE session_summaries SET
      "chainCount" = "chainCount" + 1,
      "openTaskCount" = "openTaskCount"
        + (NEW.status NOT IN ('completed', 'failed', 'cancelled', 'superseded'))::int,
      "latestStatus" = CASE WHEN NEW."lastUpdatedAt" >= "lastActivityAt" THEN NEW.status ELSE "latestStatus" END,
      "lastActivityAt" = CASE WHEN "lastActivityAt" IS NULL OR NEW."lastUpdatedAt" IS NULL THEN NULL
        ELSE GREATEST("lastActivityAt", NEW."lastUpdatedAt") END,
      "lastHumanAt" = CASE WHEN NEW."requestedByUserId" IS NOT NULL AND NEW."requestedByUserIdInherited" = false
        AND COALESCE(NEW.source, '') NOT IN ('mcp', 'system', 'schedule', 'workflow')
        AND ("lastHumanAt" IS NULL OR NEW."createdAt" > "lastHumanAt")
        THEN NEW."createdAt" ELSE "lastHumanAt" END
    WHERE "rootId" = (SELECT "rootId" FROM session_members WHERE "taskId" = NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_task_insert AFTER INSERT ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION session_task_insert();

CREATE FUNCTION session_task_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status NOT IN ('completed', 'failed', 'cancelled', 'superseded'))
    IS DISTINCT FROM (NEW.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')) THEN
    UPDATE session_summaries SET
      "openTaskCount" = "openTaskCount"
        + CASE WHEN NEW.status NOT IN ('completed', 'failed', 'cancelled', 'superseded') THEN 1 ELSE -1 END
    WHERE "rootId" = (SELECT "rootId" FROM session_members WHERE "taskId" = NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_task_open BEFORE UPDATE OF status ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION session_task_open();

CREATE FUNCTION session_task_activity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."lastUpdatedAt" >= OLD."lastUpdatedAt" THEN
    UPDATE session_summaries SET
      "latestStatus" = CASE WHEN NEW."lastUpdatedAt" >= "lastActivityAt" THEN NEW.status ELSE "latestStatus" END,
      "lastActivityAt" = CASE WHEN "lastActivityAt" IS NULL OR NEW."lastUpdatedAt" IS NULL THEN NULL
        ELSE GREATEST("lastActivityAt", NEW."lastUpdatedAt") END
    WHERE "rootId" = (SELECT "rootId" FROM session_members WHERE "taskId" = NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_task_activity AFTER UPDATE OF "lastUpdatedAt", status ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION session_task_activity();

CREATE FUNCTION session_task_activity_rewind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."lastUpdatedAt" < OLD."lastUpdatedAt" THEN
    INSERT INTO session_summary_recompute ("rootId")
    SELECT "rootId" FROM session_members WHERE "taskId" = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_task_activity_rewind AFTER UPDATE OF "lastUpdatedAt" ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION session_task_activity_rewind();

CREATE FUNCTION session_root_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parentTaskId" IS NULL AND (
    OLD."createdAt" IS DISTINCT FROM NEW."createdAt" OR OLD.source IS DISTINCT FROM NEW.source
    OR OLD."key" IS DISTINCT FROM NEW."key"
    OR OLD."requestedByUserId" IS DISTINCT FROM NEW."requestedByUserId"
    OR OLD."scheduleId" IS DISTINCT FROM NEW."scheduleId"
    OR OLD."taskType" IS DISTINCT FROM NEW."taskType"
    OR OLD."slackChannelId" IS DISTINCT FROM NEW."slackChannelId"
    OR OLD."contextKey" IS DISTINCT FROM NEW."contextKey") THEN
    UPDATE session_summaries SET
      "createdAt" = NEW."createdAt", source = NEW.source, "key" = NEW."key",
      "requestedByUserId" = NEW."requestedByUserId", "scheduleId" = NEW."scheduleId",
      "taskType" = NEW."taskType", "slackChannelId" = NEW."slackChannelId",
      "contextKey" = NEW."contextKey"
    WHERE "rootId" = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_root_columns
AFTER UPDATE OF "createdAt", source, "key", "requestedByUserId", "scheduleId", "taskType",
  "slackChannelId", "contextKey" ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION session_root_columns();

CREATE FUNCTION session_task_human() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."requestedByUserId" IS DISTINCT FROM NEW."requestedByUserId"
    OR OLD."requestedByUserIdInherited" IS DISTINCT FROM NEW."requestedByUserIdInherited"
    OR OLD.source IS DISTINCT FROM NEW.source
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    INSERT INTO session_summary_recompute ("rootId")
    SELECT "rootId" FROM session_members WHERE "taskId" = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_task_human
AFTER UPDATE OF "requestedByUserId", "requestedByUserIdInherited", source, "createdAt" ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION session_task_human();

CREATE FUNCTION session_task_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM session_members WHERE "taskId" = OLD.id OR "rootId" = OLD.id;
  DELETE FROM session_summaries WHERE "rootId" = OLD.id;
  INSERT INTO session_summary_recompute ("rootId")
  SELECT "rootId" FROM session_members WHERE "taskId" = OLD."parentTaskId";
  RETURN NULL;
END $$;
CREATE TRIGGER session_task_delete AFTER DELETE ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION session_task_delete();

CREATE FUNCTION session_approval_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sourceTaskId" IS NOT NULL AND NEW.status = 'pending' THEN
    INSERT INTO session_summary_recompute ("rootId")
    SELECT "rootId" FROM session_members WHERE "taskId" = NEW."sourceTaskId";
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_approval_insert AFTER INSERT ON approval_requests
FOR EACH ROW EXECUTE FUNCTION session_approval_insert();

CREATE FUNCTION session_approval_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."sourceTaskId" IS DISTINCT FROM NEW."sourceTaskId"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR (OLD.status = 'pending') IS DISTINCT FROM (NEW.status = 'pending') THEN
    INSERT INTO session_summary_recompute ("rootId")
    SELECT "rootId" FROM session_members WHERE "taskId" IN (OLD."sourceTaskId", NEW."sourceTaskId");
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_approval_update
AFTER UPDATE OF "sourceTaskId", status, "createdAt" ON approval_requests
FOR EACH ROW EXECUTE FUNCTION session_approval_update();

CREATE FUNCTION session_approval_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."sourceTaskId" IS NOT NULL AND OLD.status = 'pending' THEN
    INSERT INTO session_summary_recompute ("rootId")
    SELECT "rootId" FROM session_members WHERE "taskId" = OLD."sourceTaskId";
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_approval_delete AFTER DELETE ON approval_requests
FOR EACH ROW EXECUTE FUNCTION session_approval_delete();

CREATE FUNCTION session_steering_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by_kind = 'user' AND NEW.status <> 'cancelled' THEN
    INSERT INTO session_summary_recompute ("rootId")
    SELECT "rootId" FROM session_members WHERE "taskId" = NEW.task_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_steering_insert AFTER INSERT ON task_steering_messages
FOR EACH ROW EXECUTE FUNCTION session_steering_insert();

CREATE FUNCTION session_steering_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.created_by_kind IS DISTINCT FROM NEW.created_by_kind
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR (OLD.status = 'cancelled') IS DISTINCT FROM (NEW.status = 'cancelled') THEN
    INSERT INTO session_summary_recompute ("rootId")
    SELECT "rootId" FROM session_members WHERE "taskId" IN (OLD.task_id, NEW.task_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_steering_update
AFTER UPDATE OF task_id, created_by_kind, status, created_at ON task_steering_messages
FOR EACH ROW EXECUTE FUNCTION session_steering_update();

CREATE FUNCTION session_steering_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.created_by_kind = 'user' AND OLD.status <> 'cancelled' THEN
    INSERT INTO session_summary_recompute ("rootId")
    SELECT "rootId" FROM session_members WHERE "taskId" = OLD.task_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER session_steering_delete AFTER DELETE ON task_steering_messages
FOR EACH ROW EXECUTE FUNCTION session_steering_delete();

-- ---------------------------------------------------------------------------
-- Slack and chat relay (9)
-- ---------------------------------------------------------------------------

CREATE FUNCTION enqueue_chat_relay_after_terminal_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed', 'failed', 'cancelled')
    AND NEW."contextKey" LIKE 'task:chat-sdk:%'
    AND (
      NEW.source = 'chat'
      OR (NEW.source = 'system' AND NEW."taskType" = 'follow-up')
      OR (
        NEW.source = 'schedule'
        AND NEW."taskType" = 'deferred'
        AND EXISTS (
          SELECT 1 FROM agent_tasks parent
          WHERE parent.id = NEW."parentTaskId"
            AND parent."agentId" = NEW."agentId"
            AND parent."contextKey" = NEW."contextKey"
        )
      )
      OR (
        NEW.source = 'system'
        AND NEW."taskType" = 'resume'
        AND EXISTS (SELECT 1 FROM agents WHERE agents.id = NEW."agentId" AND agents."isLead" = true)
      )
    ) THEN
    INSERT INTO chat_relay_obligations (task_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER enqueue_chat_relay_after_terminal_insert AFTER INSERT ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION enqueue_chat_relay_after_terminal_insert();

CREATE FUNCTION enqueue_chat_relay_after_terminal_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
    AND NEW.status IN ('completed', 'failed', 'cancelled')
    AND NEW."contextKey" LIKE 'task:chat-sdk:%'
    AND (
      NEW.source = 'chat'
      OR (NEW.source = 'system' AND NEW."taskType" = 'follow-up')
      OR (
        NEW.source = 'schedule'
        AND NEW."taskType" = 'deferred'
        AND EXISTS (
          SELECT 1 FROM agent_tasks parent
          WHERE parent.id = NEW."parentTaskId"
            AND parent."agentId" = NEW."agentId"
            AND parent."contextKey" = NEW."contextKey"
        )
      )
      OR (
        NEW.source = 'system'
        AND NEW."taskType" = 'resume'
        AND EXISTS (SELECT 1 FROM agents WHERE agents.id = NEW."agentId" AND agents."isLead" = true)
      )
    ) THEN
    INSERT INTO chat_relay_obligations (task_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER enqueue_chat_relay_after_terminal_update AFTER UPDATE OF status ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION enqueue_chat_relay_after_terminal_update();

CREATE FUNCTION drop_chat_relay_on_defer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deferredAt" IS NOT NULL AND OLD."deferredAt" IS NULL THEN
    DELETE FROM chat_relay_obligations
    WHERE task_id = NEW.id AND delivered_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER drop_chat_relay_on_defer AFTER UPDATE OF "deferredAt" ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION drop_chat_relay_on_defer();

CREATE FUNCTION enqueue_slack_relay_after_terminal_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed', 'failed', 'cancelled')
    AND NEW.source = 'slack'
    AND NEW."slackChannelId" IS NOT NULL
    AND NEW."slackThreadTs" IS NOT NULL THEN
    INSERT INTO slack_relay_obligations (task_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER enqueue_slack_relay_after_terminal_insert AFTER INSERT ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION enqueue_slack_relay_after_terminal_insert();

CREATE FUNCTION enqueue_slack_relay_after_terminal_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
    AND NEW.status IN ('completed', 'failed', 'cancelled')
    AND NEW.source = 'slack'
    AND NEW."slackChannelId" IS NOT NULL
    AND NEW."slackThreadTs" IS NOT NULL THEN
    INSERT INTO slack_relay_obligations (task_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER enqueue_slack_relay_after_terminal_update AFTER UPDATE OF status ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION enqueue_slack_relay_after_terminal_update();

CREATE FUNCTION reopen_slack_tree_after_task_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."slackChannelId" IS NOT NULL AND NEW."slackThreadTs" IS NOT NULL THEN
    UPDATE slack_messages SET closed_at = NULL
     WHERE kind = 'tree'
       AND channel_id = NEW."slackChannelId"
       AND thread_ts = NEW."slackThreadTs"
       AND closed_at IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER reopen_slack_tree_after_task_insert AFTER INSERT ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION reopen_slack_tree_after_task_insert();

CREATE FUNCTION reopen_slack_tree_after_task_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."slackChannelId" IS NOT NULL AND NEW."slackThreadTs" IS NOT NULL THEN
    UPDATE slack_messages SET closed_at = NULL
     WHERE kind = 'tree'
       AND channel_id = NEW."slackChannelId"
       AND thread_ts = NEW."slackThreadTs"
       AND closed_at IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER reopen_slack_tree_after_task_update
AFTER UPDATE OF status, "lastUpdatedAt", "slackChannelId", "slackThreadTs" ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION reopen_slack_tree_after_task_update();

-- The UPDATE below fires this trigger again for each reopened tree row; the
-- kind = 'outcome' test stops it there (SQLite does not recurse at all).
CREATE FUNCTION reopen_slack_tree_after_outcome_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'outcome' THEN
    UPDATE slack_messages SET closed_at = NULL
     WHERE kind = 'tree'
       AND channel_id = NEW.channel_id
       AND thread_ts = NEW.thread_ts
       AND closed_at IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER reopen_slack_tree_after_outcome_insert AFTER INSERT ON slack_messages
FOR EACH ROW EXECUTE FUNCTION reopen_slack_tree_after_outcome_insert();

CREATE FUNCTION reopen_slack_tree_after_outcome_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'outcome' THEN
    UPDATE slack_messages SET closed_at = NULL
     WHERE kind = 'tree'
       AND channel_id = NEW.channel_id
       AND thread_ts = NEW.thread_ts
       AND closed_at IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER reopen_slack_tree_after_outcome_update AFTER UPDATE ON slack_messages
FOR EACH ROW EXECUTE FUNCTION reopen_slack_tree_after_outcome_update();

-- ---------------------------------------------------------------------------
-- Immutability (3)
-- ---------------------------------------------------------------------------

CREATE FUNCTION agent_history_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_history is append-only';
END $$;
CREATE TRIGGER agent_history_no_update BEFORE UPDATE ON agent_history
FOR EACH ROW EXECUTE FUNCTION agent_history_no_update();

CREATE FUNCTION agent_history_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_history is append-only';
END $$;
CREATE TRIGGER agent_history_no_delete BEFORE DELETE ON agent_history
FOR EACH ROW EXECUTE FUNCTION agent_history_no_delete();

CREATE FUNCTION session_task_parent_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."parentTaskId" IS DISTINCT FROM NEW."parentTaskId" THEN
    RAISE EXCEPTION 'agent_tasks.parentTaskId is immutable (session_members depends on it)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_task_parent_immutable BEFORE UPDATE OF "parentTaskId" ON agent_tasks
FOR EACH ROW EXECUTE FUNCTION session_task_parent_immutable();

-- ---------------------------------------------------------------------------
-- RBAC default role (1; created at boot by src/be/rbac-roles.ts on SQLite)
-- ---------------------------------------------------------------------------

CREATE FUNCTION trg_users_default_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO principal_roles ("principalType", "principalId", "roleId")
  SELECT 'user', NEW.id, 'rbac-role-admin'
  WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'rbac-role-admin')
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_users_default_role AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION trg_users_default_role();

-- ---------------------------------------------------------------------------
-- Cascades (2)
-- ---------------------------------------------------------------------------

CREATE FUNCTION cancel_approval_request_after_workflow_step_cancel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE approval_requests
    SET status = 'cancelled',
        "resolutionReason" = COALESCE(NEW.error, 'Human-in-the-loop step cancelled'),
        "resolvedAt" = statement_timestamp(),
        "updatedAt" = statement_timestamp()
    WHERE "workflowRunStepId" = NEW.id AND status = 'pending';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cancel_approval_request_after_workflow_step_cancel
AFTER UPDATE OF status ON workflow_run_steps
FOR EACH ROW EXECUTE FUNCTION cancel_approval_request_after_workflow_step_cancel();

CREATE FUNCTION script_runs_delete_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."sourceHash" IS NOT NULL THEN
    DELETE FROM script_run_sources
    WHERE hash = OLD."sourceHash"
      AND NOT EXISTS (SELECT 1 FROM script_runs WHERE "sourceHash" = OLD."sourceHash");
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER script_runs_delete_source AFTER DELETE ON script_runs
FOR EACH ROW EXECUTE FUNCTION script_runs_delete_source();
