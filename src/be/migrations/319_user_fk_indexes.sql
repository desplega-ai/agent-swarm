-- Index every column that references users(id) and had no leading index, and
-- the requester that workflow_runs stores inside its JSON context.
--
-- Incident 2026-11-09: merging two users froze the API for 278 s on an 85 GB
-- production database. deleteUser rewrites every nullable user FK column
-- (UPDATE t SET col = ? WHERE col = ?) and then DELETE FROM users runs the FK
-- parent-delete check against every child table. Without an index on the
-- child column both steps scan the full table: workflow_run_steps (981k rows)
-- took 41 s, workflow_runs (493k) 27 s, script_runs (378k) 15 s, and the final
-- DELETE 10 s. Every statement is synchronous bun:sqlite on the event loop.
--
-- deleteUser also rewrites context.swarm.requestedByUserId inside the
-- workflow_runs JSON. Those two passes parsed the JSON of every row (153 s and
-- 23 s on prod). The expression index at the end of this file serves them.

-- Partial indexes (WHERE col IS NOT NULL) serve "col = ?" lookups and the FK
-- check equally, and cost nothing for rows with no user attribution. The list
-- is generated from pragma_foreign_key_list on a fresh database plus the two
-- scheduled_tasks audit columns whose FKs migration 103 dropped. Columns that
-- already had a leading index (agent_tasks, pages, scripts, skills, workflows
-- created_by, agent_tasks.requestedByUserId, the userId columns) are skipped.
-- session_shares.userId is the exception: its only index (session_shares_user,
-- migration 230) is partial on revokedAt IS NULL, which neither the rewrite
-- nor the FK check can use, so it gets a plain partial index here.

CREATE INDEX IF NOT EXISTS idx_agent_memory_created_by ON agent_memory(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_memory_updated_by ON agent_memory(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agentmail_inbox_mappings_created_by ON agentmail_inbox_mappings(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agentmail_inbox_mappings_updated_by ON agentmail_inbox_mappings(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_created_by ON agents(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_updated_by ON agents(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_requests_created_by ON approval_requests(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_requests_updated_by ON approval_requests(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_key_history_changed_by ON asset_key_history(changed_by) WHERE changed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_key_mappings_created_by ON asset_key_mappings(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_key_mappings_updated_by ON asset_key_mappings(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budgets_created_by ON budgets(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budgets_updated_by ON budgets(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channel_messages_created_by ON channel_messages(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channel_messages_updated_by ON channel_messages(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_created_by ON channels(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_updated_by ON channels(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checklist_items_userId ON checklist_items(userId) WHERE userId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_connector_codes_user_id ON connector_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_improvements_created_by ON improvements(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_improvements_updated_by ON improvements(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_item_state_created_by ON inbox_item_state(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_item_state_updated_by ON inbox_item_state(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_messages_created_by ON inbox_messages(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_messages_updated_by ON inbox_messages(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kv_entries_created_by ON kv_entries(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kv_entries_updated_by ON kv_entries(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_created_by ON mcp_servers(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_updated_by ON mcp_servers(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_metric_versions_created_by ON metric_versions(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_metric_versions_updated_by ON metric_versions(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_metrics_created_by ON metrics(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_metrics_updated_by ON metrics(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_catalog_overlay_created_by ON model_catalog_overlay(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_catalog_overlay_updated_by ON model_catalog_overlay(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_groups_created_by ON model_groups(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_groups_updated_by ON model_groups(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_profiles_created_by ON model_profiles(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_model_profiles_updated_by ON model_profiles(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_authorizations_connectedByUserId ON oauth_authorizations(connectedByUserId) WHERE connectedByUserId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_pending_userId ON oauth_pending(userId) WHERE userId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_page_versions_created_by ON page_versions(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_page_versions_updated_by ON page_versions(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_updated_by ON pages(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pricing_created_by ON pricing(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pricing_updated_by ON pricing(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_principal_roles_created_by ON principal_roles(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_principal_roles_updated_by ON principal_roles(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prompt_template_history_created_by ON prompt_template_history(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prompt_template_history_updated_by ON prompt_template_history(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prompt_templates_created_by ON prompt_templates(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prompt_templates_updated_by ON prompt_templates(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_role_permissions_created_by ON role_permissions(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_role_permissions_updated_by ON role_permissions(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_roles_created_by ON roles(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_roles_updated_by ON roles(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_cache_releases_created_by ON runtime_cache_releases(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_cache_releases_updated_by ON runtime_cache_releases(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_controllers_created_by ON runtime_controllers(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_controllers_updated_by ON runtime_controllers(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_pools_created_by ON runtime_pools(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_pools_updated_by ON runtime_pools(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_created_by ON scheduled_tasks(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_updated_by ON scheduled_tasks(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_apis_created_by ON script_apis(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_apis_updated_by ON script_apis(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_connections_created_by ON script_connections(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_connections_updated_by ON script_connections(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_credential_bindings_created_by ON script_credential_bindings(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_credential_bindings_updated_by ON script_credential_bindings(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_run_journal_created_by ON script_run_journal(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_run_journal_updated_by ON script_run_journal(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_runs_created_by ON script_runs(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_runs_requestedByUserId ON script_runs(requestedByUserId) WHERE requestedByUserId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_runs_updated_by ON script_runs(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_versions_created_by ON script_versions(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_script_versions_updated_by ON script_versions(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scripts_updated_by ON scripts(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_services_created_by ON services(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_services_updated_by ON services(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_shares_created_by ON session_shares(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_shares_revokedBy ON session_shares(revokedBy) WHERE revokedBy IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_shares_updated_by ON session_shares(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_shares_userId ON session_shares(userId) WHERE userId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skill_files_created_by ON skill_files(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skill_files_updated_by ON skill_files(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skills_updated_by ON skills(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_slack_inbound_receipts_created_by ON slack_inbound_receipts(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_slack_inbound_receipts_updated_by ON slack_inbound_receipts(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swarm_config_created_by ON swarm_config(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swarm_config_updated_by ON swarm_config(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swarm_repos_created_by ON swarm_repos(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swarm_repos_updated_by ON swarm_repos(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_attachments_created_by ON task_attachments(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_attachments_updated_by ON task_attachments(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_citations_created_by ON task_citations(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_citations_updated_by ON task_citations(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_steering_messages_created_by_user_id ON task_steering_messages(created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_templates_created_by ON task_templates(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_templates_updated_by ON task_templates(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_ui_action_runs_created_by ON task_ui_action_runs(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_ui_action_runs_updated_by ON task_ui_action_runs(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_ui_specs_created_by ON task_ui_specs(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_ui_specs_updated_by ON task_ui_specs(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_external_ids_created_by ON user_external_ids(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_external_ids_updated_by ON user_external_ids(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_tokens_created_by ON user_tokens(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_tokens_updated_by ON user_tokens(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_updated_by ON users(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_created_by ON workflow_run_steps(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_updated_by ON workflow_run_steps(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_by ON workflow_runs(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_updated_by ON workflow_runs(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_versions_created_by ON workflow_versions(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_versions_updated_by ON workflow_versions(updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflows_updated_by ON workflows(updated_by) WHERE updated_by IS NOT NULL;

-- The requester inside the workflow context. deleteUser's JSON passes filter
-- on this exact expression (src/be/db/user-references.ts); SQLite matches an
-- expression index only against an identical expression. The CASE guard keeps
-- malformed JSON out of json_extract, which would otherwise raise during the
-- index build. created_by is not a substitute: a node whose id is "swarm"
-- can overwrite ctx.swarm, so the two values are not guaranteed to agree.
-- Building this index parses the context of every run once.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_context_requester
  ON workflow_runs(CASE WHEN json_valid(context) THEN json_extract(context, '$.swarm.requestedByUserId') END)
  WHERE CASE WHEN json_valid(context) THEN json_extract(context, '$.swarm.requestedByUserId') END IS NOT NULL;
