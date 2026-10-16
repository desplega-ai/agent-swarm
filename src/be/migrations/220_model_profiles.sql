-- Model profiles (runbooks/model-tiers.md § Model profiles): a named
-- (harness, model, effort) that Lead picks per task or that applies as an
-- agent's default. Claim stamps the profile on the task. The tier seeds
-- (`<harness>-<tier>`) are written at boot by src/be/seed-model-profiles.ts.
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL UNIQUE,
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  allowCustomModel INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  -- `tier:<tier>` for a boot seed, `agent-config` for a profile this migration
  -- made from an agent's MODEL_OVERRIDE, NULL for one an operator created.
  seededFrom TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

-- `profile` is the creator's ask; `resolvedProfile` is the name claim applied
-- (the task's ask or the agent's default), mirroring model / resolvedModel.
ALTER TABLE agent_tasks ADD COLUMN profile TEXT;
ALTER TABLE agent_tasks ADD COLUMN resolvedProfile TEXT;

-- A profile name a task asks for, or an agent has as its default, must exist
-- when the row is written. Enforced here so the check and the write are one
-- statement: an app-level check before a separate insert races a concurrent
-- delete. The delete side is the matching single-statement guard in
-- deleteModelProfile (src/be/db/model-profiles.ts). It is not a trigger on
-- model_profiles because one reading agent_tasks would break every later
-- migration that rebuilds agent_tasks (DROP + RENAME re-parses that trigger).
CREATE TRIGGER IF NOT EXISTS model_profiles_task_ref_insert
BEFORE INSERT ON agent_tasks
WHEN NEW.profile IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.profile)
BEGIN
  SELECT RAISE(ABORT, 'model-profile-missing: the task''s model profile does not exist');
END;

CREATE TRIGGER IF NOT EXISTS model_profiles_task_ref_update
BEFORE UPDATE OF profile ON agent_tasks
WHEN NEW.profile IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = NEW.profile)
BEGIN
  SELECT RAISE(ABORT, 'model-profile-missing: the task''s model profile does not exist');
END;

CREATE TRIGGER IF NOT EXISTS model_profiles_default_ref_insert
BEFORE INSERT ON swarm_config
WHEN NEW.scope = 'agent' AND NEW.key = 'MODEL_PROFILE'
  AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = trim(NEW.value))
BEGIN
  SELECT RAISE(ABORT, 'model-profile-missing: the agent''s default model profile does not exist');
END;

CREATE TRIGGER IF NOT EXISTS model_profiles_default_ref_update
BEFORE UPDATE OF scope, key, value ON swarm_config
WHEN NEW.scope = 'agent' AND NEW.key = 'MODEL_PROFILE'
  AND NOT EXISTS (SELECT 1 FROM model_profiles WHERE name = trim(NEW.value))
BEGIN
  SELECT RAISE(ABORT, 'model-profile-missing: the agent''s default model profile does not exist');
END;

-- Each agent's MODEL_OVERRIDE + REASONING_EFFORT_OVERRIDE pair becomes a
-- profile, deduped by (harness, model, effort), and that agent's default
-- (agent-scoped MODEL_PROFILE, never exported to the worker env). Claim then
-- supplies the same model and effort the worker read from its env before.
-- A row with exportToEnv = 0 never reached the worker, so it is not carried
-- over: a withheld model makes no default, a withheld effort no profile effort.
-- ACP keeps MODEL_OVERRIDE (no portable mapping); `latest:` aliases are not
-- valid agent defaults, so they are left alone too.
CREATE TEMP TABLE _model_profile_overrides AS
SELECT
  a.id AS agentId,
  COALESCE(a.harness_provider, a.provider) AS harness,
  trim(m.value) AS model,
  CASE
    WHEN lower(trim(e.value)) IN ('off', 'low', 'medium', 'high', 'xhigh', 'max')
      THEN lower(trim(e.value))
  END AS effort
FROM agents a
JOIN swarm_config m
  ON m.scope = 'agent' AND m.scopeId = a.id AND m.key = 'MODEL_OVERRIDE'
  AND m.isSecret = 0 AND m.encrypted = 0 AND m.exportToEnv = 1
LEFT JOIN swarm_config e
  ON e.scope = 'agent' AND e.scopeId = a.id AND e.key = 'REASONING_EFFORT_OVERRIDE'
  AND e.isSecret = 0 AND e.encrypted = 0 AND e.exportToEnv = 1
WHERE COALESCE(a.harness_provider, a.provider) IS NOT NULL
  AND COALESCE(a.harness_provider, a.provider) <> 'acp'
  AND trim(m.value) <> ''
  AND lower(trim(m.value)) NOT LIKE 'latest:%';

-- Name: `<harness>-<model>[-<effort>]`, without repeating a harness prefix the
-- model already carries, e.g. `codex-gpt-6.1-sol-xhigh`, `claude-opus-5-5-high`.
INSERT OR IGNORE INTO model_profiles
  (name, harness, model, effort, allowCustomModel, description, seededFrom, createdAt, lastUpdatedAt)
SELECT
  lower(replace(replace(
    CASE WHEN lower(model) LIKE lower(harness) || '-%' THEN model ELSE harness || '-' || model END,
    '/', '-'), ':', '-')) || COALESCE('-' || effort, ''),
  harness,
  model,
  effort,
  1,
  'Created from an agent''s MODEL_OVERRIDE and REASONING_EFFORT_OVERRIDE.',
  'agent-config',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM _model_profile_overrides
GROUP BY harness, model, effort;

INSERT OR IGNORE INTO swarm_config
  (id, scope, scopeId, key, value, isSecret, envPath, description, createdAt, lastUpdatedAt, encrypted, exportToEnv)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  'agent',
  o.agentId,
  'MODEL_PROFILE',
  p.name,
  0,
  NULL,
  'Default model profile, created from this agent''s MODEL_OVERRIDE.',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  0,
  0
FROM _model_profile_overrides o
JOIN model_profiles p
  ON p.harness = o.harness AND p.model = o.model AND p.effort IS o.effort
  AND p.seededFrom = 'agent-config';

DROP TABLE _model_profile_overrides;
