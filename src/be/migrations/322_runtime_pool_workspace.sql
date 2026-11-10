-- Persistent per-agent workspace volumes for runtime pools.
-- NULL keeps the pre-existing ephemeral behaviour.
ALTER TABLE runtime_pools ADD COLUMN workspace TEXT CHECK (workspace IS NULL OR json_valid(workspace));
ALTER TABLE runtime_instances ADD COLUMN workspace_slot INTEGER CHECK (workspace_slot IS NULL OR workspace_slot >= 0);
-- One live runtime per (agent, slot): a second reconciler loses the insert instead of sharing a volume.
CREATE UNIQUE INDEX idx_runtime_instances_workspace_slot
  ON runtime_instances(agent_id, workspace_slot)
  WHERE workspace_slot IS NOT NULL AND status != 'offline';
