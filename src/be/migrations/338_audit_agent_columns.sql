-- Who created / last updated a script, skill, workflow or schedule, as an
-- agent next to the existing person columns (created_by / updated_by, 082).
-- The agent columns carry the calling agent; NULL means a human, a seed or a
-- system write. skills.ownerAgentId keeps meaning ownership, not creator.

ALTER TABLE scripts ADD COLUMN updatedByAgentId TEXT;
ALTER TABLE workflows ADD COLUMN updatedByAgentId TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN updatedByAgentId TEXT;
ALTER TABLE skills ADD COLUMN createdByAgentId TEXT;
ALTER TABLE skills ADD COLUMN updatedByAgentId TEXT;

-- Deterministic backfill only. No person backfill: nothing records it.
-- An agent-owned skill was created by its owner (skill-create and extension
-- installs set ownerAgentId to the caller; seeds and remote installs leave it NULL).
UPDATE skills SET createdByAgentId = ownerAgentId WHERE ownerAgentId IS NOT NULL;

-- Every script content write records a script_versions row, so the newest
-- one names the last agent to change it.
UPDATE scripts SET updatedByAgentId = (
  SELECT v.changedByAgentId FROM script_versions v
  WHERE v.scriptId = scripts.id
  ORDER BY v.version DESC LIMIT 1
);

-- Versioned workflow updates snapshot the prior state with the updating agent.
UPDATE workflows SET updatedByAgentId = (
  SELECT v.changedByAgentId FROM workflow_versions v
  WHERE v.workflowId = workflows.id
  ORDER BY v.version DESC LIMIT 1
);
