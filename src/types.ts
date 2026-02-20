import * as z from "zod";

// Task status - includes new unassigned and offered states
export const AgentTaskStatusSchema = z.enum([
  "backlog", // Task is in backlog, not yet ready for pool
  "unassigned", // Task pool - no owner yet
  "offered", // Offered to agent, awaiting accept/reject
  "reviewing", // Agent is reviewing an offered task
  "pending", // Assigned/accepted, waiting to start
  "in_progress",
  "paused", // Interrupted by graceful shutdown, can resume
  "completed",
  "failed",
  "cancelled", // Task was cancelled by lead or creator
]);

// ============================================================================
// Lead Inbox Types
// ============================================================================

export const InboxMessageStatusSchema = z.enum([
  "unread",
  "processing",
  "read",
  "responded",
  "delegated",
]);

export const InboxMessageSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(), // Lead agent who received this
  content: z.string().min(1), // The message content
  source: z.enum(["slack", "agentmail"]).default("slack"),
  status: InboxMessageStatusSchema.default("unread"),

  // Slack context (for replying)
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),

  // Routing info
  matchedText: z.string().optional(), // Why it was routed here

  // Delegation tracking
  delegatedToTaskId: z.uuid().optional(), // If delegated, which task
  responseText: z.string().optional(), // If responded directly

  // Timestamps
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
});

export type InboxMessageStatus = z.infer<typeof InboxMessageStatusSchema>;
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

export const AgentTaskSourceSchema = z.enum(["mcp", "slack", "api", "github", "agentmail"]);
export type AgentTaskSource = z.infer<typeof AgentTaskSourceSchema>;

export const AgentTaskSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid().nullable(), // Nullable for unassigned tasks
  creatorAgentId: z.uuid().optional(), // Who created this task (optional for Slack/API)
  task: z.string().min(1),
  status: AgentTaskStatusSchema,
  source: AgentTaskSourceSchema.default("mcp"),

  // Task metadata
  taskType: z.string().max(50).optional(), // e.g., "bug", "feature", "chore"
  tags: z.array(z.string()).default([]), // e.g., ["urgent", "frontend"]
  priority: z.number().int().min(0).max(100).default(50),
  dependsOn: z.array(z.uuid()).default([]), // Task IDs this depends on

  // Acceptance tracking
  offeredTo: z.uuid().optional(), // Agent the task was offered to
  offeredAt: z.iso.datetime().optional(),
  acceptedAt: z.iso.datetime().optional(),
  rejectionReason: z.string().optional(),

  // Timestamps
  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  lastUpdatedAt: z.iso.datetime().default(() => new Date().toISOString()),
  finishedAt: z.iso.datetime().optional(),
  notifiedAt: z.iso.datetime().optional(),

  // Completion data
  failureReason: z.string().optional(),
  output: z.string().optional(),
  progress: z.string().optional(),

  // Slack-specific metadata (optional)
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),

  // GitHub-specific metadata (optional)
  githubRepo: z.string().optional(),
  githubEventType: z.string().optional(),
  githubNumber: z.number().int().optional(),
  githubCommentId: z.number().int().optional(),
  githubAuthor: z.string().optional(),
  githubUrl: z.string().optional(),

  // AgentMail-specific metadata (optional)
  agentmailInboxId: z.string().optional(),
  agentmailMessageId: z.string().optional(),
  agentmailThreadId: z.string().optional(),

  // Mention-to-task metadata (optional)
  mentionMessageId: z.uuid().optional(),
  mentionChannelId: z.uuid().optional(),

  // Epic association (optional)
  epicId: z.uuid().optional(),

  // Session attachment (optional)
  parentTaskId: z.uuid().optional(),
  claudeSessionId: z.string().optional(),
});

export const AgentStatusSchema = z.enum(["idle", "busy", "offline"]);

export const AgentSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  isLead: z.boolean().default(false),
  status: AgentStatusSchema,

  // Profile fields
  description: z.string().optional(),
  role: z.string().max(100).optional(), // Free-form, e.g., "frontend dev"
  capabilities: z.array(z.string()).default([]), // e.g., ["typescript", "react"]

  // Personal CLAUDE.md content (max 64KB)
  claudeMd: z.string().max(65536).optional(),

  // Soul: Persona, behavioral directives (injected via --append-system-prompt)
  soulMd: z.string().max(65536).optional(),
  // Identity: Expertise, working style, self-evolution notes (injected via --append-system-prompt)
  identityMd: z.string().max(65536).optional(),
  // Setup script: Runs at container start, agent-evolved (synced to /workspace/start-up.sh)
  setupScript: z.string().max(65536).optional(),
  // Tools/environment reference: Operational knowledge (synced to /workspace/TOOLS.md)
  toolsMd: z.string().max(65536).optional(),

  // Concurrency limit (defaults to 1 for backwards compatibility)
  maxTasks: z.number().int().min(1).max(20).optional(),

  // Polling limit tracking (consecutive empty polls)
  emptyPollCount: z.number().int().min(0).optional(),

  createdAt: z.iso.datetime().default(() => new Date().toISOString()),
  lastUpdatedAt: z.iso.datetime().default(() => new Date().toISOString()),
});

export const AgentWithTasksSchema = AgentSchema.extend({
  tasks: z.array(AgentTaskSchema).default([]),
});

export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type AgentWithTasks = z.infer<typeof AgentWithTasksSchema>;

// Channel Types
export const ChannelTypeSchema = z.enum(["public", "dm"]);

export const ChannelSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: ChannelTypeSchema.default("public"),
  createdBy: z.uuid().optional(),
  participants: z.array(z.uuid()).default([]), // For DMs
  createdAt: z.iso.datetime(),
});

export const ChannelMessageSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  agentId: z.uuid().nullable(), // Null for human users
  agentName: z.string().optional(), // Denormalized for convenience, "Human" when agentId is null
  content: z.string().min(1).max(4000),
  replyToId: z.uuid().optional(),
  mentions: z.array(z.uuid()).default([]), // Agent IDs mentioned
  createdAt: z.iso.datetime(),
});

export type ChannelType = z.infer<typeof ChannelTypeSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;

// Service Types (for PM2/background services)
export const ServiceStatusSchema = z.enum(["starting", "healthy", "unhealthy", "stopped"]);

export const ServiceSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  name: z.string().min(1).max(50),
  port: z.number().int().min(1).max(65535).default(3000),
  description: z.string().optional(),
  url: z.string().url().optional(),
  healthCheckPath: z.string().default("/health"),
  status: ServiceStatusSchema.default("starting"),

  // PM2 configuration (required for ecosystem-based restart)
  script: z.string().min(1), // Path to script (required)
  cwd: z.string().optional(), // Working directory (defaults to script dir)
  interpreter: z.string().optional(), // e.g., "node", "bun" (auto-detected if not set)
  args: z.array(z.string()).optional(), // Command line arguments
  env: z.record(z.string(), z.string()).optional(), // Environment variables

  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
});

export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export type Service = z.infer<typeof ServiceSchema>;

// Agent Log Types
export const AgentLogEventTypeSchema = z.enum([
  "agent_joined",
  "agent_status_change",
  "agent_left",
  "task_created",
  "task_status_change",
  "task_progress",
  // Task pool events
  "task_offered",
  "task_accepted",
  "task_rejected",
  "task_claimed",
  "task_released",
  "channel_message",
  // Service registry events
  "service_registered",
  "service_unregistered",
  "service_status_change",
]);

export const AgentLogSchema = z.object({
  id: z.uuid(),
  eventType: AgentLogEventTypeSchema,
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  oldValue: z.string().optional(),
  newValue: z.string().optional(),
  metadata: z.string().optional(),
  createdAt: z.iso.datetime(),
});

export type AgentLogEventType = z.infer<typeof AgentLogEventTypeSchema>;
export type AgentLog = z.infer<typeof AgentLogSchema>;

// Session Log Types (raw CLI output)
export const SessionLogSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid().optional(),
  sessionId: z.string(),
  iteration: z.number().int().min(1),
  cli: z.string().default("claude"),
  content: z.string(), // Raw JSON line
  lineNumber: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});

export type SessionLog = z.infer<typeof SessionLogSchema>;

// Session Cost Types (aggregated cost data per session)
export const SessionCostSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  taskId: z.uuid().optional(),
  agentId: z.uuid(),
  totalCostUsd: z.number().min(0),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  cacheReadTokens: z.number().int().min(0).default(0),
  cacheWriteTokens: z.number().int().min(0).default(0),
  durationMs: z.number().int().min(0),
  numTurns: z.number().int().min(1),
  model: z.string(),
  isError: z.boolean().default(false),
  createdAt: z.iso.datetime(),
});

export type SessionCost = z.infer<typeof SessionCostSchema>;

// ============================================================================
// Scheduled Task Types
// ============================================================================

export const ScheduledTaskSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    cronExpression: z.string().optional(),
    intervalMs: z.number().int().positive().optional(),
    taskTemplate: z.string().min(1),
    taskType: z.string().max(50).optional(),
    tags: z.array(z.string()).default([]),
    priority: z.number().int().min(0).max(100).default(50),
    targetAgentId: z.uuid().optional(),
    enabled: z.boolean().default(true),
    lastRunAt: z.iso.datetime().optional(),
    nextRunAt: z.iso.datetime().optional(),
    createdByAgentId: z.uuid().optional(),
    timezone: z.string().default("UTC"),
    createdAt: z.iso.datetime(),
    lastUpdatedAt: z.iso.datetime(),
  })
  .refine((data) => data.cronExpression || data.intervalMs, {
    message: "Either cronExpression or intervalMs must be provided",
  });

export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

// ============================================================================
// Epic Types
// ============================================================================

export const EpicStatusSchema = z.enum([
  "draft", // Epic is being defined
  "active", // Epic is in progress
  "paused", // Epic is temporarily paused
  "completed", // All tasks completed
  "cancelled", // Epic was cancelled
]);

export const EpicSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  goal: z.string().min(1),
  prd: z.string().optional(), // Product Requirements Document
  plan: z.string().optional(), // Implementation plan
  status: EpicStatusSchema.default("draft"),
  priority: z.number().int().min(0).max(100).default(50),
  tags: z.array(z.string()).default([]),
  createdByAgentId: z.uuid().optional(),
  leadAgentId: z.uuid().optional(),
  channelId: z.uuid().optional(), // Internal messaging channel for this epic
  researchDocPath: z.string().optional(),
  planDocPath: z.string().optional(),
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  githubRepo: z.string().optional(),
  githubMilestone: z.string().optional(),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
});

export type EpicStatus = z.infer<typeof EpicStatusSchema>;
export type Epic = z.infer<typeof EpicSchema>;

// Epic with computed progress
export const EpicWithProgressSchema = EpicSchema.extend({
  taskStats: z.object({
    total: z.number(),
    completed: z.number(),
    failed: z.number(),
    inProgress: z.number(),
    pending: z.number(),
  }),
  progress: z.number().min(0).max(100), // Percentage
});

export type EpicWithProgress = z.infer<typeof EpicWithProgressSchema>;

// ============================================================================
// Swarm Config Types (Centralized Environment/Config Management)
// ============================================================================

export const SwarmConfigScopeSchema = z.enum(["global", "agent", "repo"]);

export const SwarmConfigSchema = z.object({
  id: z.string().uuid(),
  scope: SwarmConfigScopeSchema,
  scopeId: z.string().nullable(), // agentId or repoId, null for global
  key: z.string().min(1).max(255),
  value: z.string(),
  isSecret: z.boolean(),
  envPath: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});

export type SwarmConfigScope = z.infer<typeof SwarmConfigScopeSchema>;
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

// ============================================================================
// Swarm Repos Types (Centralized Repository Management)
// ============================================================================

export const SwarmRepoSchema = z.object({
  id: z.string().uuid(),
  url: z.string().min(1),
  name: z.string().min(1).max(100),
  clonePath: z.string().min(1),
  defaultBranch: z.string().default("main"),
  autoClone: z.boolean().default(true),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});

export type SwarmRepo = z.infer<typeof SwarmRepoSchema>;

// ============================================================================
// Agent Memory Types (Persistent Memory System)
// ============================================================================

export const AgentMemoryScopeSchema = z.enum(["agent", "swarm"]);
export const AgentMemorySourceSchema = z.enum([
  "manual",
  "file_index",
  "session_summary",
  "task_completion",
]);

export const AgentMemorySchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  scope: AgentMemoryScopeSchema,
  name: z.string().min(1).max(500),
  content: z.string(),
  summary: z.string().nullable(),
  source: AgentMemorySourceSchema,
  sourceTaskId: z.string().uuid().nullable(),
  sourcePath: z.string().nullable(),
  chunkIndex: z.number().int().min(0).default(0),
  totalChunks: z.number().int().min(1).default(1),
  tags: z.array(z.string()),
  createdAt: z.string(),
  accessedAt: z.string(),
});

export type AgentMemoryScope = z.infer<typeof AgentMemoryScopeSchema>;
export type AgentMemorySource = z.infer<typeof AgentMemorySourceSchema>;
export type AgentMemory = z.infer<typeof AgentMemorySchema>;
