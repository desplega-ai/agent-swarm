import * as z from "zod";

// Task status - includes new unassigned and offered states
export const AgentTaskStatusSchema = z.enum([
  "unassigned", // Task pool - no owner yet
  "offered", // Offered to agent, awaiting accept/reject
  "reviewing", // Agent is reviewing an offered task
  "pending", // Assigned/accepted, waiting to start
  "in_progress",
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
  source: z.enum(["slack"]).default("slack"),
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

export const AgentTaskSourceSchema = z.enum(["mcp", "slack", "api", "github"]);
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

  // Mention-to-task metadata (optional)
  mentionMessageId: z.uuid().optional(),
  mentionChannelId: z.uuid().optional(),
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

  // Concurrency limit (defaults to 1 for backwards compatibility)
  maxTasks: z.number().int().min(1).max(20).optional(),

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
