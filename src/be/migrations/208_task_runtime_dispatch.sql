-- Preserve every dispatched slot before the worker registers its session.
-- No foreign key: task history must survive runtime pruning.
ALTER TABLE agent_tasks ADD COLUMN runtime_instance_id TEXT;
CREATE INDEX idx_agent_tasks_runtime_instance_id ON agent_tasks(runtime_instance_id);
