/**
 * Tool classification for context optimization.
 *
 * CORE_TOOLS: Always in Claude Code's context (no Tool Search needed).
 * These are tools that every worker/lead session needs immediately at startup
 * for task lifecycle, basic communication, and memory recall.
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

  // Communication (used every session)
  "read-messages", // internal swarm chat
  "post-message", // internal swarm chat

  // Memory (used at session start)
  "memory-search", // recall relevant context
  "memory-get", // retrieve full memory content
  "memory-delete", // delete own memories

  // Swarm awareness
  "get-swarm", // check who's online
]);

/** Tools that can be discovered via Tool Search on demand */
export const DEFERRED_TOOLS = new Set([
  // Scheduling (5)
  "list-schedules",
  "create-schedule",
  "update-schedule",
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

  // Config (4)
  "set-config",
  "get-config",
  "list-config",
  "delete-config",

  // Repos (2)
  "get-repos",
  "update-repo",

  // Profiles (3)
  "update-profile",
  "context-history",
  "context-diff",

  // Slack (6)
  "slack-reply",
  "slack-read",
  "slack-upload-file",
  "slack-download-file",
  "slack-list-channels",
  "slack-post",

  // Channel management (2)
  "create-channel",
  "delete-channel",
  "list-channels",

  // AgentMail (1)
  "register-agentmail-inbox",

  // Tracker (6)
  "tracker-status",
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

  // Debug (1)
  "db-query",

  // Approval Requests (1)
  "request-human-input",

  // Skills (11)
  "skill-create",
  "skill-update",
  "skill-delete",
  "skill-get",
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

  // Other (3)
  "cancel-task",
  "inject-learning",
]);

/** All known tool names = CORE_TOOLS ∪ DEFERRED_TOOLS */
export const ALL_TOOLS = new Set([...CORE_TOOLS, ...DEFERRED_TOOLS]);
