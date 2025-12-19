import * as z from "zod";

// Task status - includes new unassigned and offered states
export const AgentTaskStatusSchema = z.enum([
  "unassigned", // Task pool - no owner yet
  "offered", // Offered to agent, awaiting accept/reject
  "pending", // Assigned/accepted, waiting to start
  "in_progress",
  "completed",
  "failed",
]);

export const AgentTaskSourceSchema = z.enum(["mcp", "slack", "api"]);
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

  // Completion data
  failureReason: z.string().optional(),
  output: z.string().optional(),
  progress: z.string().optional(),

  // Slack-specific metadata (optional)
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),

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
  description: z.string().max(500).optional(),
  role: z.string().max(100).optional(), // Free-form, e.g., "frontend dev"
  capabilities: z.array(z.string()).default([]), // e.g., ["typescript", "react"]

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

// Agent Log Types
export const AgentLogEventTypeSchema = z.enum([
  "agent_joined",
  "agent_status_change",
  "agent_left",
  "task_created",
  "task_status_change",
  "task_progress",
  // New events
  "task_offered",
  "task_accepted",
  "task_rejected",
  "task_claimed",
  "task_released",
  "channel_message",
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
