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

-- Each agent's MODEL_OVERRIDE + REASONING_EFFORT_OVERRIDE pair becomes a
-- profile, deduped by (harness, model, effort), and that agent's default
-- (agent-scoped MODEL_PROFILE, never exported to the worker env). Claim then
-- supplies the same model and effort the worker read from its env before.
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
  AND m.isSecret = 0 AND m.encrypted = 0
LEFT JOIN swarm_config e
  ON e.scope = 'agent' AND e.scopeId = a.id AND e.key = 'REASONING_EFFORT_OVERRIDE'
  AND e.isSecret = 0 AND e.encrypted = 0
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
