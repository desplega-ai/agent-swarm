# Head-schema triggers, grouped by rule

The head schema has 65 triggers (migrations applied to an empty database, then
`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger'`). A port to another
storage engine re-implements each one. Each group has one black-box scenario in
`scripts/e2e/scenarios/trigger-<group>.ts` that proves the rule through the API.

Totals: 51 covered (3 of them by the invariant only, because the refusal path cannot be
provoked), 14 unreachable.

| Group | Triggers | Covered | Unreachable | Scenario |
|---|---|---|---|---|
| Asset keys | 15 | 15 | 0 | `trigger-asset-keys` |
| Model profiles and groups | 12 | 10 | 2 | `trigger-model-profiles` |
| Session maintenance | 14 | 9 | 5 | `trigger-session-maintenance` |
| FTS sync | 9 | 8 | 1 | `trigger-fts-sync` |
| Slack and chat relay | 9 | 4 | 5 | `trigger-chat-relay` |
| Immutability | 3 | 3 (invariant only) | 0 | `trigger-immutability` |
| RBAC default role | 1 | 1 | 0 | `trigger-rbac-default-role` |
| Cascades | 2 | 1 | 1 | `trigger-cascades` |

## All triggers

| Trigger | Table | Group | Covered by |
|---|---|---|---|
| validate_agent_tasks_asset_key_insert | agent_tasks | Asset keys | trigger-asset-keys |
| validate_agent_tasks_asset_key_update | agent_tasks | Asset keys | trigger-asset-keys |
| validate_pages_asset_key_insert | pages | Asset keys | trigger-asset-keys |
| validate_pages_asset_key_update | pages | Asset keys | trigger-asset-keys |
| validate_apps_asset_key_insert | apps | Asset keys | trigger-asset-keys (default key on create; the create route takes no key) |
| validate_apps_asset_key_update | apps | Asset keys | trigger-asset-keys |
| validate_scripts_asset_key_insert | scripts | Asset keys | trigger-asset-keys (default key on create; the upsert route takes no key) |
| validate_scripts_asset_key_update | scripts | Asset keys | trigger-asset-keys |
| validate_scheduled_tasks_asset_key_insert | scheduled_tasks | Asset keys | trigger-asset-keys |
| validate_scheduled_tasks_asset_key_update | scheduled_tasks | Asset keys | trigger-asset-keys |
| validate_workflows_asset_key_insert | workflows | Asset keys | trigger-asset-keys |
| validate_workflows_asset_key_update | workflows | Asset keys | trigger-asset-keys |
| validate_asset_key_mappings_insert | asset_key_mappings | Asset keys | trigger-asset-keys |
| validate_asset_key_mappings_update | asset_key_mappings | Asset keys | trigger-asset-keys |
| detach_asset_key_mapping_before_attachment_delete | task_attachments | Asset keys | trigger-asset-keys |
| model_profiles_name_space_insert | model_profiles | Model profiles and groups | trigger-model-profiles |
| model_groups_name_space_insert | model_groups | Model profiles and groups | trigger-model-profiles |
| model_profiles_task_ref_insert | agent_tasks | Model profiles and groups | trigger-model-profiles |
| model_profiles_task_ref_update | agent_tasks | Model profiles and groups | unreachable: no API changes a task's `profile` after the insert |
| model_groups_task_ref_insert | agent_tasks | Model profiles and groups | trigger-model-profiles |
| model_groups_task_ref_update | agent_tasks | Model profiles and groups | unreachable: no API changes a task's `modelGroup` after the insert |
| model_profiles_schedule_ref_insert | scheduled_tasks | Model profiles and groups | trigger-model-profiles |
| model_profiles_schedule_ref_update | scheduled_tasks | Model profiles and groups | trigger-model-profiles |
| model_groups_schedule_ref_insert | scheduled_tasks | Model profiles and groups | trigger-model-profiles |
| model_groups_schedule_ref_update | scheduled_tasks | Model profiles and groups | trigger-model-profiles |
| model_profiles_default_ref_insert | swarm_config | Model profiles and groups | trigger-model-profiles |
| model_profiles_default_ref_update | swarm_config | Model profiles and groups | trigger-model-profiles |
| session_task_insert | agent_tasks | Session maintenance | trigger-session-maintenance |
| session_task_open | agent_tasks | Session maintenance | trigger-session-maintenance |
| session_task_activity | agent_tasks | Session maintenance | trigger-session-maintenance |
| session_root_columns | agent_tasks | Session maintenance | trigger-session-maintenance (key move, requester merge) |
| session_task_human | agent_tasks | Session maintenance | trigger-session-maintenance (requester merge recomputes; lastHumanAt stays) |
| session_task_activity_rewind | agent_tasks | Session maintenance | unreachable: no API moves a task's `lastUpdatedAt` backwards |
| session_task_delete | agent_tasks | Session maintenance | unreachable: no API deletes an `agent_tasks` row |
| session_approval_insert | approval_requests | Session maintenance | trigger-session-maintenance |
| session_approval_update | approval_requests | Session maintenance | trigger-session-maintenance |
| session_approval_delete | approval_requests | Session maintenance | unreachable: only the workflow-run retention sweep deletes approval rows |
| session_steering_insert | task_steering_messages | Session maintenance | trigger-session-maintenance |
| session_steering_update | task_steering_messages | Session maintenance | unreachable: the only reachable change (carry to a wake or retry task) stays in one session and changes no summary value; nothing sets `cancelled` |
| session_steering_delete | task_steering_messages | Session maintenance | unreachable: rows go only with their task, which is never deleted |
| session_summary_recompute_apply | session_summary_recompute | Session maintenance | trigger-session-maintenance (every recompute above) |
| agent_tasks_fts_insert | agent_tasks | FTS sync | trigger-fts-sync |
| agent_tasks_fts_update | agent_tasks | FTS sync | trigger-fts-sync (title set, rename, clear) |
| agent_tasks_fts_delete | agent_tasks | FTS sync | unreachable: no API deletes an `agent_tasks` row |
| skills_fts_insert | skills | FTS sync | trigger-fts-sync |
| skills_fts_update | skills | FTS sync | trigger-fts-sync |
| skills_fts_delete | skills | FTS sync | trigger-fts-sync |
| skills_meta_fts_insert | skills | FTS sync | trigger-fts-sync (rank only: the meta index orders results, it does not filter them) |
| skills_meta_fts_update | skills | FTS sync | trigger-fts-sync (rank only) |
| skills_meta_fts_delete | skills | FTS sync | trigger-fts-sync (a deleted skill is not returned) |
| enqueue_chat_relay_after_terminal_update | agent_tasks | Slack and chat relay | trigger-chat-relay |
| enqueue_chat_relay_after_terminal_insert | agent_tasks | Slack and chat relay | unreachable: no API inserts a task that is already terminal |
| drop_chat_relay_on_defer | agent_tasks | Slack and chat relay | trigger-chat-relay |
| enqueue_slack_relay_after_terminal_update | agent_tasks | Slack and chat relay | trigger-chat-relay |
| enqueue_slack_relay_after_terminal_insert | agent_tasks | Slack and chat relay | unreachable: no API inserts a task that is already terminal |
| reopen_slack_tree_after_task_insert | agent_tasks | Slack and chat relay | trigger-chat-relay |
| reopen_slack_tree_after_task_update | agent_tasks | Slack and chat relay | unreachable in isolation: a closed tree's tasks are terminal, and no API step rewrites them after the tree closes |
| reopen_slack_tree_after_outcome_insert | slack_messages | Slack and chat relay | unreachable in isolation: an outcome card follows a task in the thread, whose insert already reopened the tree |
| reopen_slack_tree_after_outcome_update | slack_messages | Slack and chat relay | unreachable in isolation: same reason as the insert |
| agent_history_no_update | agent_history | Immutability | trigger-immutability (invariant only: no API updates a history row; earlier events stay byte-identical) |
| agent_history_no_delete | agent_history | Immutability | trigger-immutability (invariant only: no API deletes a history row; events only accumulate) |
| session_task_parent_immutable | agent_tasks | Immutability | trigger-immutability (invariant only: no API writes `parentTaskId`; a chain move keeps it) |
| trg_users_default_role | users | RBAC default role | trigger-rbac-default-role |
| cancel_approval_request_after_workflow_step_cancel | workflow_run_steps | Cascades | trigger-cascades |
| script_runs_delete_source | script_runs | Cascades | unreachable: only the hourly retention sweep deletes `script_runs`, and only runs older than at least one day |

## Notes

- `trg_users_default_role` is created by `src/be/rbac-roles.ts` at boot, not by a migration
  file. A port must create it at the same point.
- The asset-key routes validate keys in the app before the write. The scenario proves the
  rule (canonical key, existing user for `personal/`), whichever layer refuses.
- Task search falls back to `LIKE` until the post-boot backfill completes. Skill search
  falls back to a name-ordered substring match when the index has no hit, so the skill
  assertions check rank as well as membership.
