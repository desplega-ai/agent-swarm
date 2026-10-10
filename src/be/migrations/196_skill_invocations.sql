-- Skill invocation analytics.
--
-- `skill.invoke` telemetry already lands in `events`, but nothing links those
-- rows to `skills`. This adds a per-skill counter and a per-invocation history,
-- both written by the API in the same transaction that stores the event
-- (src/be/skill-invocations.ts).

ALTER TABLE skills ADD COLUMN invocationCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN lastInvokedAt TEXT;

CREATE TABLE IF NOT EXISTS skill_invocations (
  id TEXT PRIMARY KEY,
  -- NULL when the invoked name resolves to no skills row (e.g. a harness-native
  -- skill the swarm does not manage). The row is still recorded; the counter is not.
  skillId TEXT REFERENCES skills(id) ON DELETE SET NULL,
  -- Canonical name of the resolved row, else the name the worker reported.
  skillName TEXT,
  -- `skills.version` of the resolved row at invocation time; NULL when skillId is NULL.
  skillVersion INTEGER,
  -- Estimated size of the loaded skill content, ceil(chars / 4)
  -- (estimateTokens in src/be/memory/key-browser.ts); NULL when skillId is NULL.
  tokenCount INTEGER,
  agentId TEXT,
  taskId TEXT,
  sessionId TEXT,
  harness TEXT,
  -- "tool" | "prompt" | "read" (src/providers/skill-invoke.ts).
  via TEXT,
  -- The `events` row this invocation came from.
  eventId TEXT,
  createdAt TEXT NOT NULL
);

-- One invocation per skill per runner session, enforced server-side so a
-- resumed session or an id-only load after a name-only load never counts twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_invocations_session_skill
  ON skill_invocations(sessionId, skillName)
  WHERE sessionId IS NOT NULL AND skillName IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill_time
  ON skill_invocations(skillId, createdAt);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_name_time
  ON skill_invocations(skillName, createdAt);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_agent_time
  ON skill_invocations(agentId, createdAt);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_created
  ON skill_invocations(createdAt);
