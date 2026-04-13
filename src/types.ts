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

export const AgentTaskSourceSchema = z.enum([
  "mcp",
  "slack",
  "api",
  "github",
  "gitlab",
  "agentmail",
  "system",
  "schedule",
  "workflow",
  "linear",
]);
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
  slackReplySent: z.boolean().default(false),

  // VCS metadata (GitHub / GitLab — provider-agnostic)
  vcsProvider: z.enum(["github", "gitlab"]).optional(),
  vcsRepo: z.string().optional(),
  vcsEventType: z.string().optional(),
  vcsNumber: z.number().int().optional(),
  vcsCommentId: z.number().int().optional(),
  vcsAuthor: z.string().optional(),
  vcsUrl: z.string().optional(),
  vcsInstallationId: z.number().int().optional(),
  vcsNodeId: z.string().optional(),

  // AgentMail-specific metadata (optional)
  agentmailInboxId: z.string().optional(),
  agentmailMessageId: z.string().optional(),
  agentmailThreadId: z.string().optional(),

  // Mention-to-task metadata (optional)
  mentionMessageId: z.uuid().optional(),
  mentionChannelId: z.uuid().optional(),

  // Working directory (optional — must be an absolute path for the agent process)
  dir: z.string().min(1).startsWith("/").optional(),

  // Session attachment (optional)
  parentTaskId: z.uuid().optional(),
  claudeSessionId: z.string().optional(),

  // Model selection (optional — defaults to "opus" via runner)
  model: z.enum(["haiku", "sonnet", "opus"]).optional(),

  // Schedule linking (optional — set when task was created by a schedule)
  scheduleId: z.uuid().optional(),

  // Workflow linking (optional — set when task was created by a workflow)
  workflowRunId: z.string().uuid().nullable().optional(),
  workflowRunStepId: z.string().uuid().nullable().optional(),

  // Structured output schema (optional — JSON Schema that task output must conform to)
  outputSchema: z.record(z.string(), z.unknown()).optional(),

  // Pause tracking
  wasPaused: z.boolean().default(false),

  // Context usage aggregates
  compactionCount: z.number().int().min(0).optional(),
  peakContextPercent: z.number().min(0).max(100).optional(),
  totalContextTokensUsed: z.number().int().min(0).optional(),
  contextWindowSize: z.number().int().min(0).optional(),

  // Credential tracking
  credentialKeySuffix: z.string().optional(),
  credentialKeyType: z.string().optional(),

  // User identity — canonical user who requested this task
  requestedByUserId: z.string().optional(),
});

// ============================================================================
// User Identity Types
// ============================================================================

export const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  email: z.string().optional(),
  role: z.string().optional(),
  notes: z.string().optional(),
  slackUserId: z.string().optional(),
  linearUserId: z.string().optional(),
  githubUsername: z.string().optional(),
  gitlabUsername: z.string().optional(),
  emailAliases: z.array(z.string()).default([]),
  preferredChannel: z.string().default("slack"),
  timezone: z.string().optional(),
  createdAt: z.iso.datetime(),
  lastUpdatedAt: z.iso.datetime(),
});

export type User = z.infer<typeof UserSchema>;

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
  // Heartbeat checklist: Standing orders checked periodically (synced to /workspace/HEARTBEAT.md)
  heartbeatMd: z.string().max(65536).optional(),

  // Concurrency limit (defaults to 1 for backwards compatibility)
  maxTasks: z.number().int().min(1).max(100).optional(),

  // Polling limit tracking (consecutive empty polls)
  emptyPollCount: z.number().int().min(0).optional(),

  // Last session activity timestamp (updated on tool calls, task updates, etc.)
  lastActivityAt: z.iso.datetime().optional(),

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

// ============================================================================
// Context Versioning Types
// ============================================================================

export const ChangeSourceSchema = z.enum([
  "self_edit",
  "lead_coaching",
  "api",
  "system",
  "session_sync",
]);

export const VersionableFieldSchema = z.enum([
  "soulMd",
  "identityMd",
  "toolsMd",
  "claudeMd",
  "setupScript",
  "heartbeatMd",
]);

export const ContextVersionSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  field: VersionableFieldSchema,
  content: z.string(),
  version: z.number().int().min(1),
  changeSource: ChangeSourceSchema,
  changedByAgentId: z.uuid().nullable(),
  changeReason: z.string().nullable(),
  contentHash: z.string(),
  previousVersionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export type ChangeSource = z.infer<typeof ChangeSourceSchema>;
export type VersionableField = z.infer<typeof VersionableFieldSchema>;
export type ContextVersion = z.infer<typeof ContextVersionSchema>;

export type VersionMeta = {
  changeSource?: ChangeSource;
  changedByAgentId?: string | null;
  changeReason?: string | null;
};

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
// Events
// ============================================================================

export const EventCategorySchema = z.enum([
  "tool",
  "skill",
  "session",
  "api",
  "task",
  "workflow",
  "system",
]);

export const EventStatusSchema = z.enum(["ok", "error", "timeout", "skipped"]);

export const EventSourceSchema = z.enum(["worker", "api", "hook", "scheduler", "cli"]);

export const EventNameSchema = z.enum([
  // Tool events
  "tool.start",
  "tool.end",
  // Skill events
  "skill.invoke",
  "skill.complete",
  // Session events
  "session.start",
  "session.end",
  "session.resume",
  "session.cost",
  // API events
  "api.request",
  "api.error",
  // Task events
  "task.poll",
  "task.assign",
  "task.timeout",
  // Workflow events
  "workflow.step.start",
  "workflow.step.end",
  "workflow.run.start",
  "workflow.run.end",
  // System events
  "system.boot",
  "system.migration",
  "system.error",
]);

export const SwarmEventSchema = z.object({
  id: z.uuid(),
  category: EventCategorySchema,
  event: EventNameSchema,
  status: EventStatusSchema,
  source: EventSourceSchema,
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  parentEventId: z.string().optional(),
  numericValue: z.number().optional(),
  durationMs: z.number().int().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.iso.datetime(),
});

export type EventCategory = z.infer<typeof EventCategorySchema>;
export type EventStatus = z.infer<typeof EventStatusSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type EventName = z.infer<typeof EventNameSchema>;
export type SwarmEvent = z.infer<typeof SwarmEventSchema>;

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
    consecutiveErrors: z.number().int().min(0).default(0),
    lastErrorAt: z.iso.datetime().optional(),
    lastErrorMessage: z.string().optional(),
    model: z.enum(["haiku", "sonnet", "opus"]).optional(),
    scheduleType: z.enum(["recurring", "one_time"]).default("recurring"),
    createdAt: z.iso.datetime(),
    lastUpdatedAt: z.iso.datetime(),
  })
  .refine(
    (data) => {
      if (data.scheduleType === "one_time") return true;
      return data.cronExpression || data.intervalMs;
    },
    {
      message: "Either cronExpression or intervalMs must be provided for recurring schedules",
    },
  );

export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

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

export const RepoGuidelinesSchema = z.object({
  prChecks: z.array(z.string()),
  mergeChecks: z.array(z.string()),
  allowMerge: z.boolean().optional().default(false),
  review: z.array(z.string()),
});

export type RepoGuidelines = z.infer<typeof RepoGuidelinesSchema>;

export const SwarmRepoSchema = z.object({
  id: z.string().uuid(),
  url: z.string().min(1),
  name: z.string().min(1).max(100),
  clonePath: z.string().min(1),
  defaultBranch: z.string().default("main"),
  autoClone: z.boolean().default(true),
  guidelines: RepoGuidelinesSchema.nullable().optional(),
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
  expiresAt: z.string().nullable().optional(),
  accessCount: z.number().int().min(0).default(0).optional(),
  embeddingModel: z.string().nullable().optional(),
});

export type AgentMemoryScope = z.infer<typeof AgentMemoryScopeSchema>;
export type AgentMemorySource = z.infer<typeof AgentMemorySourceSchema>;
export type AgentMemory = z.infer<typeof AgentMemorySchema>;

// ============================================================================
// Active Session Types (runner session tracking)
// ============================================================================

export const ActiveSessionSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  taskId: z.string().nullable(),
  triggerType: z.string(),
  inboxMessageId: z.string().nullable(),
  taskDescription: z.string().nullable(),
  runnerSessionId: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  lastHeartbeatAt: z.iso.datetime(),
});

export type ActiveSession = z.infer<typeof ActiveSessionSchema>;

// ============================================================================
// Workflow Engine Types
// ============================================================================

// --- Retry Policy ---

export const RetryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).default(3),
  strategy: z.enum(["exponential", "static", "linear"]).default("exponential"),
  baseDelayMs: z.number().int().min(0).default(1000),
  maxDelayMs: z.number().int().min(0).default(60000),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// --- Executor Metadata ---

export const ExecutorMetaSchema = z.object({
  runId: z.string().uuid(),
  stepId: z.string().uuid(),
  nodeId: z.string(),
  workflowId: z.string().uuid(),
  dryRun: z.boolean().default(false),
});
export type ExecutorMeta = z.infer<typeof ExecutorMetaSchema>;

// --- Validation ---

export const ValidationResultSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const StepValidationConfigSchema = z.object({
  executor: z.string().default("validate"),
  config: z.record(z.string(), z.unknown()),
  mustPass: z.boolean().default(false),
  retry: RetryPolicySchema.optional(),
});
export type StepValidationConfig = z.infer<typeof StepValidationConfigSchema>;

// --- Workflow Node (nodes-with-next) ---

export const WorkflowNodeSchema = z.object({
  id: z.string().describe("Unique node identifier, used in 'next' and 'inputs' mappings"),
  type: z
    .string()
    .describe("Executor type: 'agent-task', 'script', 'raw-llm', 'validate', 'property-match'"),
  label: z.string().optional().describe("Human-readable label for UI display"),
  config: z
    .record(z.string(), z.unknown())
    .describe(
      "Executor-specific config. For agent-task: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }. " +
        "Values support {{interpolation}} from the node's inputs context. " +
        "NOTE: config.outputSchema on agent-task nodes validates the AGENT's raw JSON output, " +
        "while node-level outputSchema validates the EXECUTOR's return value ({taskId, taskOutput}).",
    ),
  next: z
    .union([z.string(), z.array(z.string()), z.record(z.string(), z.string())])
    .optional()
    .describe(
      "Next node(s): string for simple chaining, string[] for fan-out to parallel nodes, or record for port-based routing ({pass: 'a', fail: 'b'})",
    ),
  validation: StepValidationConfigSchema.optional(),
  retry: RetryPolicySchema.optional(),
  // REQUIRED for cross-node data access — without this, only 'trigger' and 'input' are available for interpolation.
  inputs: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "REQUIRED for cross-node data access. Maps local names to context paths. " +
        "Without this, upstream step outputs are NOT available for interpolation — only 'trigger' and 'input' are. " +
        'Example: { "cityData": "generate-city" } → use {{cityData.taskOutput.field}} in config templates. ' +
        'For trigger data: { "pr": "trigger.pullRequest" }.',
    ),
  inputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema to validate resolved inputs before execution"),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "JSON Schema to validate the executor's output (e.g. {taskId, taskOutput} for agent-task). " +
        "Different from config.outputSchema which validates the agent's raw output.",
    ),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

// --- Workflow Edge (derived — for UI rendering) ---

export const WorkflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  sourcePort: z.string(),
  target: z.string(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

// --- Workflow Definition (nodes-only, no explicit edges) ---

export const WorkflowDefinitionSchema = z.object({
  nodes: z.array(WorkflowNodeSchema).min(1),
  onNodeFailure: z
    .enum(["fail", "continue"])
    .default("fail")
    .describe(
      "Behavior when a node's task fails or is cancelled. " +
        "'fail' (default): mark the entire run as failed. " +
        "'continue': treat the failed node as completed with error output and proceed — " +
        "downstream convergence nodes receive '[FAILED: reason]' and can handle partial results.",
    ),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// --- Workflow Patch Schemas ---

/** Partial node update — all fields optional, id is NOT included (comes from path/nodeId) */
export const WorkflowNodePatchSchema = WorkflowNodeSchema.partial().omit({ id: true });
export type WorkflowNodePatch = z.infer<typeof WorkflowNodePatchSchema>;

/** Bulk workflow definition patch */
export const WorkflowDefinitionPatchSchema = z.object({
  update: z
    .array(
      z.object({
        nodeId: z.string().describe("ID of the node to update"),
        node: WorkflowNodePatchSchema.describe("Partial node data to merge"),
      }),
    )
    .optional()
    .describe("Nodes to update (partial merge)"),
  delete: z.array(z.string()).optional().describe("Node IDs to delete"),
  create: z.array(WorkflowNodeSchema).optional().describe("New nodes to add"),
  onNodeFailure: z
    .enum(["fail", "continue"])
    .optional()
    .describe("Update the definition-level onNodeFailure behavior"),
});
export type WorkflowDefinitionPatch = z.infer<typeof WorkflowDefinitionPatchSchema>;

/** Result of applying a patch — collects all errors instead of throwing on the first */
export interface PatchResult {
  definition: WorkflowDefinition;
  errors: string[];
}

// --- Trigger Configuration ---

export const TriggerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("webhook"),
    hmacSecret: z.string().optional(),
    hmacHeader: z.string().default("X-Hub-Signature-256"),
  }),
  z.object({
    type: z.literal("schedule"),
    scheduleId: z.string().uuid(),
  }),
]);
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

// --- Cooldown Configuration ---

export const CooldownConfigSchema = z
  .object({
    hours: z.number().min(0).optional(),
    minutes: z.number().min(0).optional(),
    seconds: z.number().min(0).optional(),
  })
  .refine((v) => v.hours !== undefined || v.minutes !== undefined || v.seconds !== undefined, {
    message: "At least one of hours, minutes, or seconds is required",
  });
export type CooldownConfig = z.infer<typeof CooldownConfigSchema>;

// --- Input Value Resolution ---

export const InputValueSchema = z.union([
  z
    .string()
    .regex(/^\$\{.+\}$/), // env var: ${MY_VAR}
  z
    .string()
    .regex(/^secret\..+$/), // swarm secret: secret.OPENAI_KEY
  z.string(), // literal value
]);
export type InputValue = z.infer<typeof InputValueSchema>;

// --- Workflow Template ---

export const WorkflowTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  variables: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      type: z.enum(["string", "number", "boolean"]),
      default: z.unknown().optional(),
      required: z.boolean().default(true),
    }),
  ),
  definition: WorkflowDefinitionSchema,
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

// --- Workflow Snapshot (for version history) ---

export const WorkflowSnapshotSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  definition: WorkflowDefinitionSchema,
  triggers: z.array(TriggerConfigSchema),
  cooldown: CooldownConfigSchema.optional(),
  input: z.record(z.string(), InputValueSchema).optional(),
  triggerSchema: z.record(z.string(), z.unknown()).optional(),
  dir: z.string().min(1).startsWith("/").optional(),
  vcsRepo: z.string().min(1).optional(),
  enabled: z.boolean(),
});
export type WorkflowSnapshot = z.infer<typeof WorkflowSnapshotSchema>;

// --- Workflow ---

export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  definition: WorkflowDefinitionSchema,
  triggers: z.array(TriggerConfigSchema).default([]),
  cooldown: CooldownConfigSchema.optional(),
  input: z.record(z.string(), InputValueSchema).optional(),
  triggerSchema: z.record(z.string(), z.unknown()).optional(),
  dir: z.string().min(1).startsWith("/").optional(),
  vcsRepo: z.string().min(1).optional(),
  createdByAgentId: z.string().uuid().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

// --- Workflow Version ---

export const WorkflowVersionSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  version: z.number().int().min(1),
  snapshot: WorkflowSnapshotSchema,
  changedByAgentId: z.string().uuid().optional(),
  createdAt: z.string(),
});
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;

// --- Workflow Run ---

export const WorkflowRunStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  status: WorkflowRunStatusSchema,
  triggerData: z.unknown().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// --- Workflow Run Step ---

export const WorkflowRunStepStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type WorkflowRunStepStatus = z.infer<typeof WorkflowRunStepStatusSchema>;

export const WorkflowRunStepSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  nodeId: z.string(),
  nodeType: z.string(),
  status: WorkflowRunStepStatusSchema,
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  retryCount: z.number().int().min(0).default(0),
  maxRetries: z.number().int().min(0).default(3),
  nextRetryAt: z.string().optional(),
  idempotencyKey: z.string().optional(),
  diagnostics: z.string().optional(),
  nextPort: z.string().optional(),
});
export type WorkflowRunStep = z.infer<typeof WorkflowRunStepSchema>;

// ============================================================================
// Prompt Template Types
// ============================================================================

export const PromptTemplateScopeSchema = z.enum(["global", "agent", "repo"]);
export const PromptTemplateStateSchema = z.enum([
  "enabled",
  "default_prompt_fallback",
  "skip_event",
]);

export const PromptTemplateSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  scope: PromptTemplateScopeSchema,
  scopeId: z.string().nullable(),
  state: PromptTemplateStateSchema,
  body: z.string(),
  isDefault: z.boolean(),
  version: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

export const PromptTemplateHistorySchema = z.object({
  id: z.string(),
  templateId: z.string(),
  version: z.number(),
  body: z.string(),
  state: z.string(),
  changedBy: z.string().nullable(),
  changedAt: z.string(),
  changeReason: z.string().nullable(),
});
export type PromptTemplateHistory = z.infer<typeof PromptTemplateHistorySchema>;

// ============================================================================
// Skill Types
// ============================================================================

export const SkillTypeSchema = z.enum(["remote", "personal"]);
export type SkillType = z.infer<typeof SkillTypeSchema>;

export const SkillScopeSchema = z.enum(["global", "swarm", "agent"]);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  type: SkillTypeSchema,
  scope: SkillScopeSchema,
  ownerAgentId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceRepo: z.string().nullable(),
  sourcePath: z.string().nullable(),
  sourceBranch: z.string(),
  sourceHash: z.string().nullable(),
  isComplex: z.boolean(),
  allowedTools: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  context: z.string().nullable(),
  agent: z.string().nullable(),
  disableModelInvocation: z.boolean(),
  userInvocable: z.boolean(),
  version: z.number(),
  isEnabled: z.boolean(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  lastFetchedAt: z.string().nullable(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const AgentSkillSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  skillId: z.string(),
  isActive: z.boolean(),
  installedAt: z.string(),
});
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

export const SkillWithInstallInfoSchema = SkillSchema.extend({
  isActive: z.boolean(),
  installedAt: z.string(),
});
export type SkillWithInstallInfo = z.infer<typeof SkillWithInstallInfoSchema>;

// ── MCP Servers ──────────────────────────────────────────────────────────

export const McpServerTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

export const McpServerScopeSchema = z.enum(["global", "swarm", "agent"]);
export type McpServerScope = z.infer<typeof McpServerScopeSchema>;

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scope: McpServerScopeSchema,
  ownerAgentId: z.string().nullable(),
  transport: McpServerTransportSchema,
  command: z.string().nullable(),
  args: z.string().nullable(),
  url: z.string().nullable(),
  headers: z.string().nullable(),
  envConfigKeys: z.string().nullable(),
  headerConfigKeys: z.string().nullable(),
  isEnabled: z.boolean(),
  version: z.number(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const AgentMcpServerSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  mcpServerId: z.string(),
  isActive: z.boolean(),
  installedAt: z.string(),
});
export type AgentMcpServer = z.infer<typeof AgentMcpServerSchema>;

export const McpServerWithInstallInfoSchema = McpServerSchema.extend({
  isActive: z.boolean(),
  installedAt: z.string(),
});
export type McpServerWithInstallInfo = z.infer<typeof McpServerWithInstallInfoSchema>;

// ============================================================================
// Context Usage Tracking Types
// ============================================================================

export const ContextSnapshotEventTypeSchema = z.enum(["progress", "compaction", "completion"]);
export type ContextSnapshotEventType = z.infer<typeof ContextSnapshotEventTypeSchema>;

export const ContextSnapshotSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  agentId: z.uuid(),
  sessionId: z.string(),

  // Context window state
  contextUsedTokens: z.number().int().min(0).optional(),
  contextTotalTokens: z.number().int().min(0).optional(),
  contextPercent: z.number().min(0).max(100).optional(),

  // Event metadata
  eventType: ContextSnapshotEventTypeSchema,

  // Compaction-specific (null for non-compaction)
  compactTrigger: z.enum(["auto", "manual"]).optional(),
  preCompactTokens: z.number().int().min(0).optional(),

  // Cumulative counters at this point
  cumulativeInputTokens: z.number().int().min(0).default(0),
  cumulativeOutputTokens: z.number().int().min(0).default(0),

  createdAt: z.iso.datetime(),
});

export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
