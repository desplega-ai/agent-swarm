-- Add nullable user audit columns to mutable/user-facing tables.
-- Existing rows and system-originated writes remain NULL.

ALTER TABLE agents ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE agents ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE channels ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE channels ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE agent_tasks ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE agent_tasks ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE channel_messages ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE channel_messages ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE services ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE services ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE inbox_messages ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE inbox_messages ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE scheduled_tasks ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE scheduled_tasks ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE swarm_config ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE swarm_config ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE swarm_repos ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE swarm_repos ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE agent_memory ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE agent_memory ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE agentmail_inbox_mappings ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE agentmail_inbox_mappings ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE workflows ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE workflows ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE workflow_runs ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE workflow_runs ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE workflow_run_steps ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE workflow_run_steps ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE workflow_versions ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE workflow_versions ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE prompt_templates ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE prompt_templates ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE prompt_template_history ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE prompt_template_history ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE approval_requests ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE approval_requests ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE mcp_servers ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE mcp_servers ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE mcp_oauth_tokens ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE mcp_oauth_tokens ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE mcp_oauth_pending ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE mcp_oauth_pending ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE task_templates ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE task_templates ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE pages ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE pages ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE page_versions ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE page_versions ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE kv_entries ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE kv_entries ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE scripts ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE scripts ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE script_versions ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE script_versions ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE skills ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE skills ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE users ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE user_external_ids ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE user_external_ids ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE user_tokens ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE user_tokens ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE task_attachments ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE task_attachments ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE budgets ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE budgets ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE pricing ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE pricing ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE inbox_item_state ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE inbox_item_state ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE metrics ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE metrics ADD COLUMN updated_by TEXT REFERENCES users(id);

ALTER TABLE metric_versions ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE metric_versions ADD COLUMN updated_by TEXT REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_by ON agent_tasks(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated_by ON agent_tasks(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflows_created_by ON workflows(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_created_by ON pages(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scripts_created_by ON scripts(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skills_created_by ON skills(created_by) WHERE created_by IS NOT NULL;
