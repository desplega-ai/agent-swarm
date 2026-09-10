/**
 * Tool classification for context optimization.
 *
 * CORE_TOOLS: Always in Claude Code's context (no Tool Search needed).
 * These cover session startup and recurring fleet-wide operations, selected
 * by distinct-task prevalence and tool-description cost.
 *
 * All other registered tools rely on Claude Code's Tool Search feature
 * (auto-activates when total tool tokens exceed ~10K).
 */

/** Tools that must always be available in context (not deferred by Tool Search) */
export const CORE_TOOLS = new Set([
  // Session bootstrap
  "join-swarm", // first tool called on startup
  "my-agent-info", // identity check
  "poll-task", // task discovery

  // Task lifecycle (used every session)
  "get-task-details", // inspect assigned task
  "store-progress", // update/complete/fail tasks
  "task-action", // claim/release/accept/reject
  "send-task", // delegate subtasks
  "get-tasks", // list/filter tasks
  "defer-task", // complete now, wake up later to continue

  // Memory (used at session start)
  "memory-search", // recall relevant context
  "memory-get", // retrieve full memory content
  "memory-store", // store a learning (used every session)
  "memory-delete", // delete own memories
  "memory_rate", // rate a memory used in this task (worker→server)

  // Swarm awareness
  "get-swarm", // check who's online

  // Recurring operations (14-day fleet task prevalence)
  "script-run", // run inline or reusable scripts
  "db-query", // inspect swarm state
  "kv-get", // retrieve durable task data
  "script-query-types", // inspect the live script SDK
  "get-repos", // locate repositories
  "accept-steer", // acknowledge task steering
  "memory-edit", // update existing learnings
  "script-search", // find reusable scripts
  "steer-task", // redirect active work
  "kv-list", // discover durable task data
  "get-config", // inspect configuration
]);

/** Tools that can be discovered via Tool Search on demand */
export const DEFERRED_TOOLS = new Set([
  // Scheduling (6)
  "list-schedules",
  "create-schedule",
  "update-schedule",
  "patch-schedule",
  "delete-schedule",
  "run-schedule-now",

  // Workflows (11)
  "create-workflow",
  "list-workflows",
  "get-workflow",
  "update-workflow",
  "patch-workflow",
  "patch-workflow-node",
  "delete-workflow",
  "trigger-workflow",
  "list-workflow-runs",
  "get-workflow-run",
  "retry-workflow-run",
  "cancel-workflow-run",

  // Services (4)
  "register-service",
  "unregister-service",
  "list-services",
  "update-service-status",

  // Config (5)
  "set-config",
  "list-config",
  "delete-config",
  "credential-bindings",
  "script-connections",

  // Repos (1)
  "update-repo",

  // Profiles (3)
  "update-profile",
  "context-history",
  "context-diff",

  // Swarm messaging (2). Deprecated: the prompt no longer names these tools.
  "read-messages",
  "post-message",

  // Slack (12): task-context gated; keep out of CORE_TOOLS
  "slack-reply",
  "slack-read",
  "slack-upload-file",
  "slack-download-file",
  "slack-list-channels",
  "slack-post",
  "slack-start-thread",
  "slack-create-channel",
  "slack-invite-to-channel",
  "slack-archive-channel",
  "slack-delete",
  "slack-update",

  // Channel management (2)
  "create-channel",
  "delete-channel",
  "list-channels",

  // AgentMail (1)
  "register-agentmail-inbox",

  // Kapso/WhatsApp (4)
  "register-kapso-number",
  "unregister-kapso-number",
  "send-whatsapp-message",
  "reply-whatsapp-message",

  // Tracker (7)
  "tracker-status",
  "get-oauth-access-token",
  "tracker-link-task",
  "tracker-unlink",
  "tracker-sync-status",
  "tracker-map-agent",

  // Prompt Templates (5)
  "list-prompt-templates",
  "get-prompt-template",
  "set-prompt-template",
  "delete-prompt-template",
  "preview-prompt-template",

  // Metrics (1)
  "create_metric",

  // Approval Requests (1)
  "request-human-input",

  // Skills (12)
  "skill-create",
  "skill-update",
  "skill-delete",
  "skill-get",
  "skill-get-file",
  "skill-list",
  "skill-search",
  "skill-install",
  "skill-uninstall",
  "skill-install-remote",
  "skill-sync-remote",
  "skill-publish",

  // MCP Servers (7)
  "mcp-server-create",
  "mcp-server-delete",
  "mcp-server-get",
  "mcp-server-install",
  "mcp-server-list",
  "mcp-server-uninstall",
  "mcp-server-update",

  // User Identity (2)
  "resolve-user",
  "manage-user",

  // Pages and apps (11)
  "app-get",
  "app-list",
  "app-patch",
  "app-query",
  "app-sync",
  "app-upsert",
  "app-history",
  "app-diff",
  "app-rollback",
  "create_page",
  "delete-page",

  // KV store (3)
  "kv-set",
  "kv-delete",
  "kv-incr",

  // Realtime rooms (4)
  "room-get",
  "room-change",
  "room-reset",
  "room-decode",

  // Reusable scripts (6)
  "script-upsert",
  "script-delete",
  "script-apis",
  "launch-script-run",
  "get-script-run",
  "list-script-runs",

  // External command routes (1)
  "swarm_x",

  // Other (3)
  "cancel-task",
  "inject-learning",
  "get-metrics",
]);

/** All known tool names = CORE_TOOLS ∪ DEFERRED_TOOLS */
export const ALL_TOOLS = new Set([...CORE_TOOLS, ...DEFERRED_TOOLS]);
