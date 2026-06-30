// Backend types (mirrored from agent-swarm backend)
export type AgentStatus = "idle" | "busy" | "offline" | "waiting_for_credentials";
export type AgentTaskStatus =
  | "backlog"
  | "unassigned"
  | "offered"
  | "reviewing"
  | "pending"
  | "in_progress"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";
export type AgentTaskSource =
  | "mcp"
  | "slack"
  | "api"
  | "ui"
  | "github"
  | "gitlab"
  | "agentmail"
  | "system"
  | "schedule"
  | "workflow"
  | "linear"
  | "jira";
export type ChannelType = "public" | "dm";
export type ModelTier = "smol" | "regular" | "smart" | "ultra";

export interface Agent {
  id: string;
  name: string;
  isLead: boolean;
  status: AgentStatus;
  description?: string;
  role?: string;
  capabilities?: string[];
  claudeMd?: string;
  soulMd?: string;
  identityMd?: string;
  toolsMd?: string;
  setupScript?: string;
  heartbeatMd?: string;
  maxTasks?: number;
  capacity?: {
    current: number;
    max: number;
    available: number;
  };
  /** Env-var names the worker is blocked on when status is `waiting_for_credentials`. */
  credentialMissing?: string[] | null;
  provider?: string;
  /**
   * Phase 1.5: canonical harness provider the worker reported at registration
   * time (or `null`/missing for legacy rows from before migration 054).
   */
  harnessProvider?: ProviderName | null;
  /**
   * Migration 055: worker-self-reported credential snapshot. Null when the
   * worker hasn't booted yet, or `CRED_CHECK_DISABLE=1` opted it out.
   */
  credStatus?: AgentCredStatus | null;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface AgentCredStatusLiveTest {
  ok: boolean;
  error?: string | null;
  latency_ms: number;
  testedAt: number;
}

export interface AgentBedrockStatusModel {
  id: string;
  name: string;
}

export interface AgentBedrockStatus {
  region: string;
  probedAt: number;
  ready: boolean;
  models: AgentBedrockStatusModel[];
  error?: string;
}

export interface AgentCredStatus {
  ready: boolean;
  missing: string[];
  satisfiedBy?: "env" | "file" | "side-effect-pending" | null;
  hint?: string | null;
  liveTest?: AgentCredStatusLiveTest | null;
  latestModel?: AgentLatestModel | null;
  reportedAt: number;
  reportKind?: "boot" | "post_task";
  /** Pi-mono Bedrock enumeration block. Null when not in Bedrock mode. */
  bedrock?: AgentBedrockStatus | null;
}

export interface AgentLatestModel {
  model: string;
  source: "task" | "agent_config" | "adapter_default" | "custom";
  taskId?: string | null;
  harnessProvider?: ProviderName | null;
  reportedAt: number;
}

export interface AgentTask {
  id: string;
  agentId: string | null;
  creatorAgentId?: string;
  task: string;
  status: AgentTaskStatus;
  source: AgentTaskSource;
  taskType?: string;
  tags: string[];
  priority: number;
  dependsOn: string[];
  offeredTo?: string;
  offeredAt?: string;
  acceptedAt?: string;
  rejectionReason?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  slackUserId?: string;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt?: string;
  failureReason?: string;
  output?: string;
  progress?: string;
  model?: string;
  modelTier?: ModelTier;
  scheduleId?: string;
  parentTaskId?: string;
  dir?: string;
  claudeSessionId?: string;
  workflowRunId?: string;
  workflowRunStepId?: string;
  vcsProvider?: string;
  vcsRepo?: string;
  vcsUrl?: string;
  vcsNumber?: number;
  vcsEventType?: string;
  vcsAuthor?: string;
  credentialKeySuffix?: string;
  credentialKeyType?: string;
  swarmVersion?: string;
  provider?: ProviderName;
  providerMeta?: DevinProviderMeta | Record<string, never>;
  harnessVariant?: string;
  harnessVariantMeta?: { version?: string; failureArtifact?: string };
  /** Sum of recorded session costs for this task. Missing when no cost rows exist. */
  totalCostUsd?: number;
  /** Phase 1 (≥1.76.0): canonical user who requested this task. */
  requestedByUserId?: string;
  /** Phase 1 (≥1.76.0): cross-ingress context key for the conversation/thread. */
  contextKey?: string;
}

export type ProviderName = "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
export type DevinProviderMeta = {
  sessionUrl: string;
  maxAcuLimit?: number;
  acuCostUsd?: number;
};

export interface AgentWithTasks extends Agent {
  tasks: AgentTask[];
}

/**
 * Identity (Phase 2 ≥1.76.0). Mirrors `UserSchema` in `src/types.ts` —
 * canonical row from the new `users` table. Phase 064: identity columns
 * normalized into `user_external_ids`; surfaced here via `identities[]`.
 *
 * Step-9 (≥1.80.0): server-side `composeUser` decorates every list/detail
 * response with `identities`, `tokens`, and `recentEvents` (limit configurable
 * via `?recentEvents=N`). All three are present on every wire row produced by
 * `/api/users*`.
 */
export interface UserIdentity {
  kind: string;
  externalId: string;
}

/**
 * Coarse user-role union. The backend stores `role` as a free-form string;
 * this union captures the values the UI currently reasons about and gives a
 * declarative type for future RBAC (e.g. `NavItem.minRole`). Loosened to
 * `string` on the `User` row since the wire value is not constrained.
 */
export type UserRole = "admin" | "member" | "viewer";

export interface User {
  id: string;
  name: string;
  email?: string;
  role?: string;
  notes?: string;
  emailAliases: string[];
  preferredChannel: string;
  timezone?: string;
  // Phase 064: list of platform identities composed from `user_external_ids`.
  identities?: UserIdentity[];
  // Phase 064: token summaries (no plaintext, just preview suffix).
  tokens?: UserToken[];
  // Phase 064: the last N identity events (server caps the limit).
  recentEvents?: IdentityEvent[];
  // Phase 064: NULL/undefined = unlimited.
  dailyBudgetUsd?: number | null;
  status: "invited" | "active" | "suspended";
  metadata?: Record<string, unknown>;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface UsersResponse {
  users: User[];
}

export interface UserResponse {
  user: User;
}

export interface MintTokenResponse {
  plaintext: string;
  token: UserToken;
  user: User;
}

export interface McpUserConfigResponse {
  mcpBaseUrl: string;
  mcpUserUrl: string;
}

export interface CreateUserInput {
  name: string;
  email?: string;
  role?: string;
  notes?: string;
  emailAliases?: string[];
  preferredChannel?: string;
  timezone?: string;
  identities?: UserIdentity[];
  dailyBudgetUsd?: number | null;
  status?: "invited" | "active" | "suspended";
  metadata?: Record<string, unknown>;
}

/**
 * PATCH /api/users/:id body. Every field is optional (server requires
 * at least one). Passing `identities` replaces the user's identity set.
 */
export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: string;
  notes?: string;
  emailAliases?: string[];
  preferredChannel?: string;
  timezone?: string;
  identities?: UserIdentity[];
  dailyBudgetUsd?: number | null;
  status?: "invited" | "active" | "suspended";
  metadata?: Record<string, unknown> | null;
}

/**
 * Identity event types — mirrors `IdentityEventTypeSchema` in `src/types.ts`
 * and the CHECK constraint on `user_identity_events.eventType` in migration 064.
 */
export type IdentityEventType =
  | "auto_merge"
  | "manual_merge"
  | "identity_added"
  | "identity_removed"
  | "email_added"
  | "email_removed"
  | "token_minted"
  | "token_revoked"
  | "budget_changed"
  | "status_changed"
  | "profile_changed";

/**
 * Server-decoded identity event (`src/be/users.ts: rowToEvent`). The
 * `before`/`after` columns are JSON-parsed server-side so the UI doesn't
 * have to repeat the parse. `eventType` is loosened to `string` on the wire
 * (the server stores raw strings) but the UI narrows to `IdentityEventType`
 * for rendering.
 */
export interface IdentityEvent {
  id: string;
  userId: string;
  eventType: IdentityEventType | string;
  actor: string;
  before: unknown | null;
  after: unknown | null;
  createdAt: string;
}

export interface IdentityEventsResponse {
  events: IdentityEvent[];
}

export interface IdentitiesResponse {
  identities: UserIdentity[];
}

/**
 * Read shape for a user-owned MCP token (Phase 064 schema, endpoints ship
 * with the future MCP-token plan). `tokenPreview` is the last 4 chars of
 * the plaintext for UI display ("…ax7b").
 */
export interface UserToken {
  id: string;
  userId: string;
  label: string | null;
  tokenPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * Unmapped identity entry surfaced by `GET /api/users/unmapped`. Composed
 * server-side by collapsing the two-key-per-identity kv shape
 * (`<externalId>:meta` + `<externalId>:count`) into a single row.
 */
export interface UnmappedIdentity {
  kind: string;
  externalId: string;
  lastSeenAt: string | null;
  count: number;
  sampleEventType: string | null;
  sampleContext: unknown | null;
}

export interface UnmappedResponse {
  unmapped: UnmappedIdentity[];
}

/**
 * Resolve body — either link to an existing user (`userId`) OR create a
 * new one inline (`name` + `email`). Mirrors the `z.union` in
 * `src/http/users.ts: resolveUnmapped`.
 */
export type ResolveUnmappedInput = { userId: string } | { name: string; email: string };

export interface MergeUsersInput {
  sourceUserId: string;
}

/**
 * Sessions surface (Phase 4 ≥1.76.0). Mirrors `SessionListItem` from
 * `src/be/db.ts:8816-8821` — root task plus chain-wide summary used by the
 * `/sessions` sidebar.
 */
export interface SessionListItem {
  root: AgentTask;
  chainTaskCount: number;
  lastActivityAt: string;
  latestStatus: AgentTaskStatus;
}

/**
 * Inbox-state (Phase 6 ≥1.76.0). Mirrors `InboxItemTypeSchema` /
 * `InboxItemStatusSchema` / `InboxItemStateSchema` in `src/types.ts:252-276`.
 *
 * One row per (userId, itemType, itemId) tuple; the dashboard inbox joins
 * server source data (approvals, agents, tasks, sessions, templates) against
 * these rows to filter out items the user has dismissed/snoozed/done.
 */
export type InboxItemType =
  | "approval"
  | "credential_missing"
  | "broken_task"
  | "to_read"
  | "to_start_template";

export type InboxItemStatus = "open" | "snoozed" | "dismissed" | "done";

export interface InboxItemState {
  id: string;
  userId: string;
  itemType: InboxItemType;
  itemId: string;
  status: InboxItemStatus;
  snoozeUntil?: string;
  dismissedAt?: string;
  doneAt?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface InboxStateResponse {
  items: InboxItemState[];
}

export interface InboxStateUpsertResponse {
  item: InboxItemState;
}

/**
 * Task templates (Phase 6 ≥1.76.0). Mirrors `TaskTemplateSchema` in
 * `src/types.ts:289-300`. Powers the "To start" inbox bucket.
 */
export type TaskTemplateKind = "task" | "workflow" | "schedule";

export interface TaskTemplate {
  id: string;
  title: string;
  description: string;
  prompt: string;
  kind: TaskTemplateKind;
  payload: Record<string, unknown>;
  category?: string;
  tags: string[];
  createdAt: string;
}

export interface TaskTemplatesResponse {
  templates: TaskTemplate[];
}

/**
 * Bulk credential-status row from `GET /api/agents/credential-status`. Mirrors
 * the handler shape at `src/http/agents.ts:466-477`. Used by the Blocking
 * inbox bucket to surface agents stuck on missing creds.
 */
export interface CredentialMissingAgent {
  agentId: string;
  name: string;
  status: AgentStatus;
  /** Top-level missing[] (older worker fallback). */
  missing: string[];
  provider: string | null;
  harnessProvider: ProviderName | null;
  /** Migration 055 worker self-report; richer per-harness snapshot. */
  credStatus: AgentCredStatus | null;
  lastCheckedAt: string;
}

export interface CredentialMissingAgentsResponse {
  agents: CredentialMissingAgent[];
}

export interface SessionsListResponse {
  sessions: SessionListItem[];
}

/**
 * Full chain payload from `GET /api/sessions/:rootTaskId`. The chain is
 * already ordered by `createdAt` server-side (via the recursive CTE) so the
 * UI can DFS from `root` without resorting.
 */
export interface SessionDetailResponse {
  root: AgentTask;
  chain: AgentTask[];
}

export type AgentLogEventType =
  | "agent_joined"
  | "agent_status_change"
  | "agent_left"
  | "task_created"
  | "task_status_change"
  | "task_progress"
  | "task_offered"
  | "task_accepted"
  | "task_rejected"
  | "task_claimed"
  | "task_released"
  | "channel_message";

export interface AgentLog {
  id: string;
  eventType: AgentLogEventType;
  agentId?: string;
  taskId?: string;
  oldValue?: string;
  newValue?: string;
  metadata?: string;
  createdAt: string;
}

export interface SessionLog {
  id: string;
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
}

export interface SessionLogsResponse {
  logs: SessionLog[];
}

export interface Channel {
  id: string;
  name: string;
  description?: string;
  type: ChannelType;
  createdBy?: string;
  participants: string[];
  createdAt: string;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  agentId?: string | null;
  agentName?: string;
  content: string;
  replyToId?: string;
  mentions: string[];
  createdAt: string;
}

export interface DashboardStats {
  agents: {
    total: number;
    idle: number;
    busy: number;
    offline: number;
  };
  tasks: {
    total: number;
    pending: number;
    in_progress: number;
    paused: number;
    completed: number;
    failed: number;
  };
}

export type TaskStatus = AgentTaskStatus;
export type Stats = DashboardStats;

export interface AgentsResponse {
  agents: Agent[] | AgentWithTasks[];
}

export interface TasksResponse {
  tasks: AgentTask[];
  total: number;
}

export interface LogsResponse {
  logs: AgentLog[];
}

export interface ChannelsResponse {
  channels: Channel[];
}

export interface MessagesResponse {
  messages: ChannelMessage[];
}

/**
 * Mirrors `TaskAttachmentKindSchema` in `src/types.ts` and the CHECK
 * constraint on `task_attachments.kind` (migration 072).
 */
export type TaskAttachmentKind = "agent-fs" | "url" | "shared-fs" | "page";

/**
 * Pointer-based artifact attached to a task via `store-progress.attachments`.
 * Mirrors `TaskAttachmentSchema` in `src/types.ts`.
 */
export interface TaskAttachment {
  id: string;
  taskId: string;
  agentId: string | null;
  name: string;
  kind: TaskAttachmentKind;
  url?: string;
  path?: string;
  pageId?: string;
  /** agent-fs only — paired with `driveId` to build a public live-host URL. */
  orgId?: string;
  /** agent-fs only — paired with `orgId` to build a public live-host URL. */
  driveId?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  intent?: string;
  description?: string;
  isPrimary: boolean;
  createdAt: string;
}

export interface TaskWithLogs extends AgentTask {
  logs: AgentLog[];
  /**
   * Pointer-based artifacts attached via `store-progress`. Always present
   * (empty array when none); ordered by `createdAt`.
   */
  attachments?: TaskAttachment[];
}

export type ServiceStatus = "starting" | "healthy" | "unhealthy" | "stopped";

export interface Service {
  id: string;
  agentId: string;
  name: string;
  port: number;
  description?: string;
  url?: string;
  healthCheckPath: string;
  status: ServiceStatus;
  script: string;
  cwd?: string;
  interpreter?: string;
  args?: string[];
  env?: Record<string, string>;
  metadata: Record<string, unknown>;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface ServicesResponse {
  services: Service[];
}

/**
 * Phase 2 + Phase 12b: tells the UI where `totalCostUsd` came from so we can
 * render a badge. See `SessionCostSourceSchema` in `src/types.ts`.
 *  - 'harness'        — value reported by the harness as-is.
 *  - 'pricing-table'  — value recomputed by the API from `pricing` rows.
 *  - 'unpriced'       — recompute attempted but no matching pricing rows.
 */
export type SessionCostSource = "harness" | "pricing-table" | "unpriced";

export interface SessionCost {
  id: string;
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  // Migration 063 nullable — adapters that can't honestly report this
  // (e.g. Codex SDK) leave it null instead of mixing fake-0 with real-0.
  cacheWriteTokens: number | null;
  reasoningOutputTokens: number;
  thinkingTokens: number;
  durationMs: number;
  // Migration 063 nullable — adapters that don't surface numTurns.
  numTurns: number | null;
  model: string;
  isError: boolean;
  // Phase 12b: surfaced on each row for the UI badge.
  costSource: SessionCostSource;
  createdAt: string;
}

export interface SessionCostsResponse {
  costs: SessionCost[];
}

export interface UsageSummaryTotals {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalDurationMs: number;
  totalSessions: number;
  avgCostPerSession: number;
}

export interface UsageSummaryDailyRow {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
}

export interface UsageSummaryByAgentRow {
  agentId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  durationMs: number;
}

export interface UsageSummaryResponse {
  totals: UsageSummaryTotals;
  daily: UsageSummaryDailyRow[];
  byAgent: UsageSummaryByAgentRow[];
}

export interface DashboardCostResponse {
  costToday: number;
  costMtd: number;
}

export interface UsageStats {
  totalCostUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionCount: number;
  totalDurationMs: number;
  avgCostPerSession: number;
}

export interface DailyUsage {
  date: string;
  costUsd: number;
  tokens: number;
  sessions: number;
}

export interface AgentUsageSummary {
  agentId: string;
  agentName?: string;
  monthlyCostUsd: number;
  monthlyTokens: number;
  sessionCount: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  cronExpression?: string;
  intervalMs?: number;
  taskTemplate: string;
  taskType?: string;
  tags: string[];
  priority: number;
  targetAgentId?: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdByAgentId?: string;
  timezone: string;
  model?: string;
  modelTier?: ModelTier;
  scheduleType?: "recurring" | "one_time";
  createdAt: string;
  lastUpdatedAt: string;
}

export interface ScheduledTasksResponse {
  scheduledTasks: ScheduledTask[];
}

export type SwarmConfigScope = "global" | "agent" | "repo";

export interface SwarmConfig {
  id: string;
  scope: SwarmConfigScope;
  scopeId: string | null;
  key: string;
  value: string;
  isSecret: boolean;
  envPath: string | null;
  description: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  // True when the row's value is stored as ciphertext server-side. Plaintext
  // rows return encrypted=false. Mirrors SwarmConfigSchema in src/types.ts.
  encrypted: boolean;
}

export interface SwarmConfigsResponse {
  configs: SwarmConfig[];
}

export interface RepoGuidelines {
  prChecks: string[];
  mergeChecks: string[];
  allowMerge: boolean;
  review: string[];
}

export interface RepoHooks {
  enabled: boolean;
}

export interface SwarmRepo {
  id: string;
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: boolean;
  hooks: RepoHooks;
  guidelines: RepoGuidelines | null;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface SwarmReposResponse {
  repos: SwarmRepo[];
}

// Workflow types

/** Node types are open strings — new executor types can be added via the registry */
export type WorkflowNodeType = string;

export interface RetryPolicy {
  maxRetries: number;
  strategy: "exponential" | "static" | "linear";
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface StepValidationConfig {
  executor: string;
  config: Record<string, unknown>;
  mustPass: boolean;
  retry?: RetryPolicy;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label?: string;
  config: Record<string, unknown>;
  next?: string | string[] | Record<string, string>;
  validation?: StepValidationConfig;
  retry?: RetryPolicy;
  inputs?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
}

/** Definition stores only nodes. Edges are auto-generated by the API. */
export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  /** Auto-generated edges returned by GET /api/workflows/:id */
  edges: WorkflowEdge[];
  onNodeFailure?: "fail" | "continue";
}

export interface TriggerConfig {
  type: "webhook" | "schedule";
  hmacSecret?: string;
  hmacHeader?: string;
  scheduleId?: string;
}

export interface CooldownConfig {
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  definition: WorkflowDefinition;
  triggers: TriggerConfig[];
  cooldown?: CooldownConfig;
  input?: Record<string, string>;
  triggerSchema?: Record<string, unknown>;
  dir?: string;
  vcsRepo?: string;
  createdByAgentId?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export type WorkflowRunStatus = "running" | "waiting" | "completed" | "failed" | "skipped";

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  triggerData?: unknown;
  context?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  lastUpdatedAt: string;
  finishedAt?: string;
}

export type WorkflowRunStepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "skipped";

export interface WorkflowRunStep {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: WorkflowRunStepStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: string;
  idempotencyKey?: string;
  diagnostics?: string;
  nextPort?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface WorkflowRunWithSteps extends WorkflowRun {
  steps: WorkflowRunStep[];
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  snapshot: {
    name: string;
    description?: string;
    definition: WorkflowDefinition;
    triggers: TriggerConfig[];
    cooldown?: CooldownConfig;
    input?: Record<string, string>;
    triggerSchema?: Record<string, unknown>;
    dir?: string;
    vcsRepo?: string;
    enabled: boolean;
  };
  changedByAgentId?: string;
  createdAt: string;
}

/**
 * Slim `/api/workflows` list row. The heavy `definition` (full DAG) and
 * trigger config are dropped — the list only needs `nodeCount`. Fetch the full
 * `Workflow` via `GET /api/workflows/{id}` (or `?fields=full` on the list).
 */
export type WorkflowSummary = Omit<
  Workflow,
  "definition" | "triggers" | "cooldown" | "input" | "triggerSchema"
> & { nodeCount: number };

export interface WorkflowsResponse {
  workflows: WorkflowSummary[];
}

export interface WorkflowRunsResponse {
  runs: WorkflowRun[];
}

export type ScriptRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted_limit";

// `workflow` = durable background run (has a journal). `inline` = synchronous one-off run.
export type ScriptRunKind = "workflow" | "inline";

export interface ScriptRun {
  id: string;
  agentId: string;
  scriptName?: string;
  source: string;
  args?: unknown;
  kind: ScriptRunKind;
  status: ScriptRunStatus;
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  output?: unknown;
  error?: string;
  lastHeartbeatAt?: string;
  idempotencyKey?: string;
  requestedByUserId?: string;
}

export type ScriptRunListItem = Omit<ScriptRun, "source" | "args" | "output">;

export type ScriptRunJournalStepType = "swarm-script" | "raw-llm" | "agent-task" | string;

export interface ScriptRunJournalEntry {
  id: string;
  runId: string;
  stepKey: string;
  stepType: ScriptRunJournalStepType;
  config: Record<string, unknown>;
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  /**
   * Real wall-clock duration of the step in milliseconds, measured in the
   * subprocess around the step's execution. Absent on runs recorded before
   * per-step timing was added (the waterfall falls back to sequence mode).
   */
  durationMs?: number;
}

export interface ScriptRunsResponse {
  runs: ScriptRunListItem[];
  total: number;
}

export interface ScriptRunWithJournal {
  run: ScriptRun;
  journal: ScriptRunJournalEntry[];
}

// Saved scripts catalog (`scripts` table — mirrors ScriptListItem/ScriptDetail in src/types.ts)

export type ScriptScope = "global" | "agent";

export type ScriptFsMode = "none" | "workspace-rw";

/** Lean projection served by `GET /api/scripts` — omits `source` and raw JSON blobs. */
export interface ScriptListItem {
  id: string;
  name: string;
  scope: ScriptScope;
  scopeId: string | null;
  description: string;
  intent: string;
  version: number;
  isScratch: boolean;
  typeChecked: boolean;
  fsMode: ScriptFsMode;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Full record served by `GET /api/scripts/{id}` — includes `source` plus parsed `signature`/`argsJsonSchema`. */
export interface ScriptDetail extends ScriptListItem {
  source: string;
  signatureJson: string;
  contentHash: string;
  signature: unknown;
  argsJsonSchema: unknown;
}

/** Row served by `GET /api/scripts/{id}/versions` — mirrors ScriptVersionRecord in src/types.ts. */
export interface ScriptVersion {
  id: string;
  scriptId: string;
  version: number;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  contentHash: string;
  changedByAgentId: string | null;
  changedAt: string;
  changeReason: string | null;
}

/** `GET /api/scripts/type-defs` — static SDK + stdlib .d.ts for the Monaco editor. */
export interface ScriptTypeDefs {
  sdkTypes: string;
  stdlibTypes: string;
}

export interface ScriptsResponse {
  scripts: ScriptListItem[];
}

// External script APIs (POST /api/x/script/<id>) — mirrors ScriptApiRecord in src/types.ts.

export type ScriptApiAuthMode = "none" | "bearer";

export interface ScriptApiRecord {
  id: string;
  scriptId: string;
  agentId: string;
  authMode: ScriptApiAuthMode;
  enabled: boolean;
  label: string | null;
  callCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Returned by create / rotate — includes the plaintext bearer token (`null` for `none`). */
export interface ScriptApiWithSecret extends ScriptApiRecord {
  token: string | null;
}

// Prompt Templates

export interface PromptTemplate {
  id: string;
  eventType: string;
  scope: "global" | "agent" | "repo";
  scopeId: string | null;
  state: "enabled" | "default_prompt_fallback" | "skip_event";
  body: string;
  isDefault: boolean;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptTemplateHistory {
  id: string;
  templateId: string;
  version: number;
  body: string;
  state: string;
  changedBy: string | null;
  changedAt: string;
  changeReason: string | null;
}

export interface EventDefinition {
  eventType: string;
  header: string;
  defaultBody: string;
  variables: { name: string; description: string; example?: string }[];
  category: "event" | "system" | "common" | "task_lifecycle" | "session";
}

export interface UpsertPromptTemplateInput {
  eventType: string;
  scope?: "global" | "agent" | "repo";
  scopeId?: string;
  state?: "enabled" | "default_prompt_fallback" | "skip_event";
  body: string;
  changedBy?: string;
  changeReason?: string;
}

export interface PreviewResponse {
  rendered: string;
  unresolved: string[];
}

export interface RenderResponse {
  text: string;
  skipped: boolean;
  unresolved: string[];
  templateId?: string;
  scope?: string;
}

// Approval Requests

export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "timeout";

export interface ApprovalQuestion {
  id: string;
  type: "approval" | "text" | "single-select" | "multi-select" | "boolean";
  label: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
  multiline?: boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
  minSelections?: number;
  maxSelections?: number;
  defaultValue?: boolean;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  questions: ApprovalQuestion[];
  approvers: {
    users?: string[];
    roles?: string[];
    policy: "any" | "all" | { min: number };
  };
  status: ApprovalRequestStatus;
  responses: Record<string, unknown> | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  sourceTaskId: string | null;
  timeoutSeconds: number | null;
  expiresAt: string | null;
  notificationChannels: Array<{ channel: string; target: string }> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestsResponse {
  approvalRequests: ApprovalRequest[];
}

// Skills
export type SkillType = "remote" | "personal";
export type SkillScope = "global" | "swarm" | "agent";

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  type: SkillType;
  scope: SkillScope;
  ownerAgentId: string | null;
  sourceUrl: string | null;
  sourceRepo: string | null;
  sourcePath: string | null;
  sourceBranch: string;
  sourceHash: string | null;
  isComplex: boolean;
  allowedTools: string | null;
  model: string | null;
  effort: string | null;
  context: string | null;
  agent: string | null;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  version: number;
  isEnabled: boolean;
  systemDefault: boolean;
  createdAt: string;
  lastUpdatedAt: string;
  lastFetchedAt: string | null;
}

export interface AgentSkill extends Skill {
  isActive: boolean;
  installedAt: string;
}

export interface SkillsResponse {
  skills: Skill[];
  total: number;
}

export interface AgentSkillsResponse {
  skills: AgentSkill[];
  total: number;
}

// MCP Servers
export type McpServerTransport = "stdio" | "http" | "sse";
export type McpServerScope = "global" | "swarm" | "agent";
export type McpAuthMethod = "static" | "oauth" | "auto";

export interface McpServer {
  id: string;
  name: string;
  description: string | null;
  scope: McpServerScope;
  ownerAgentId: string | null;
  transport: McpServerTransport;
  command: string | null;
  args: string | null;
  url: string | null;
  headers: string | null;
  envConfigKeys: string | null;
  headerConfigKeys: string | null;
  authMethod: McpAuthMethod;
  isEnabled: boolean;
  version: number;
  createdAt: string;
  lastUpdatedAt: string;
}

export type McpOAuthStatus = "connected" | "expired" | "error" | "revoked";
export type McpOAuthClientSource = "dcr" | "manual" | "preregistered";

export interface McpOAuthTokenStatus {
  id: string;
  status: McpOAuthStatus;
  tokenType: string;
  expiresAt: string | null;
  scope: string | null;
  lastErrorMessage: string | null;
  lastRefreshedAt: string | null;
  authorizationServerIssuer: string;
  resourceUrl: string;
  clientSource: McpOAuthClientSource;
  hasRefreshToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpOAuthStatusResponse {
  mcpServerId: string;
  authMethod: McpAuthMethod;
  connected: boolean;
  token: McpOAuthTokenStatus | null;
}

export interface McpOAuthMetadataResponse {
  requiresOAuth: boolean;
  resourceUrl?: string;
  authorizationServerIssuer?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  revocationUrl?: string | null;
  registrationEndpoint?: string | null;
  scopes?: string[];
  dcrSupported?: boolean;
  bearerMethodsSupported?: string[] | null;
}

export interface McpServerWithInstallInfo extends McpServer {
  isActive: boolean;
  installedAt: string;
}

export interface McpServersResponse {
  servers: McpServer[];
  total: number;
}

export interface AgentMcpServersResponse {
  servers: McpServerWithInstallInfo[];
  total: number;
}

// Context Usage
export type ContextSnapshotEventType = "progress" | "compaction" | "completion";

/**
 * Phase 12b — adapter-supplied tag describing which formula produced
 * `contextUsedTokens`. Lets the UI render the right label next to a
 * percent gauge and avoid apples-to-oranges comparisons across providers.
 */
export type ContextFormula =
  | "input-cache-output"
  | "input-cache-no-output"
  | "input-output-no-cache"
  | "peak-proxy"
  | "pi-delegated"
  | "harness-reported"
  | "unknown";

export interface ContextSnapshot {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  contextUsedTokens?: number;
  contextTotalTokens?: number;
  contextPercent?: number;
  eventType: ContextSnapshotEventType;
  // Migration 063 added 'auto-inferred' (e.g. claude-managed when the SDK
  // doesn't expose pre-compact counts and we use a proxy).
  compactTrigger?: "auto" | "manual" | "auto-inferred";
  preCompactTokens?: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  // Phase 12b — surface to the UI.
  contextFormula?: ContextFormula;
  createdAt: string;
}

export interface ContextSummary {
  compactionCount: number;
  peakContextPercent: number | null;
  // Migration 063: renamed from totalContextTokensUsed; monotonic max across snapshots.
  peakContextTokens: number | null;
  contextWindowSize: number | null;
  snapshotCount: number;
}

export interface TaskContextResponse {
  snapshots: ContextSnapshot[];
  summary: ContextSummary;
}

// API Key Status
export type ApiKeyStatusType = "available" | "rate_limited";

export interface ApiKeyStatus {
  id: string;
  keyType: string;
  keySuffix: string;
  keyIndex: number;
  scope: string;
  scopeId: string;
  status: ApiKeyStatusType;
  rateLimitedUntil: string | null;
  lastUsedAt: string | null;
  lastRateLimitAt: string | null;
  totalUsageCount: number;
  rateLimitCount: number;
  /** Auto-derived harness provider (claude/pi/codex). */
  provider: string;
  /** Optional human-friendly label set from the dashboard. */
  name: string | null;
  rateLimitWindows: Record<
    string,
    {
      status: string;
      utilization?: number;
      resetsAt?: number;
      isUsingOverage?: boolean;
      surpassedThreshold?: number;
      lastSeenAt: string;
    }
  >;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyStatusResponse {
  success: boolean;
  keys: ApiKeyStatus[];
}

export interface KeyCostSummary {
  keyType: string;
  keySuffix: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  taskCount: number;
}

export interface KeyCostResponse {
  success: boolean;
  costs: KeyCostSummary[];
}

// Debug / DB Explorer
export interface DbQueryRequest {
  sql: string;
  params?: unknown[];
}

export interface DbQueryResponse {
  columns: string[];
  rows: unknown[][];
  elapsed: number;
  total: number;
}

// Budgets & Pricing — see src/types.ts in the API repo for the source of truth.
export type BudgetScope = "global" | "agent" | "user";

export interface Budget {
  scope: BudgetScope;
  scopeId: string;
  dailyBudgetUsd: number;
  createdAt: number;
  lastUpdatedAt: number;
}

export interface BudgetsResponse {
  budgets: Budget[];
}

export type BudgetRefusalCause = "agent" | "global";

export interface BudgetRefusalNotification {
  taskId: string;
  date: string;
  agentId: string;
  cause: BudgetRefusalCause;
  agentSpendUsd?: number | null;
  agentBudgetUsd?: number | null;
  globalSpendUsd?: number | null;
  globalBudgetUsd?: number | null;
  followUpTaskId?: string | null;
  createdAt: number;
}

export interface BudgetRefusalsResponse {
  refusals: BudgetRefusalNotification[];
}

export type PricingProvider = "claude" | "codex" | "pi";
export type PricingTokenClass = "input" | "cached_input" | "output";

export interface PricingRow {
  provider: PricingProvider;
  model: string;
  tokenClass: PricingTokenClass;
  effectiveFrom: number;
  pricePerMillionUsd: number;
  createdAt: number;
  lastUpdatedAt: number;
}

export interface PricingResponse {
  rows: PricingRow[];
}

// ============================================================================
// Memory
// ============================================================================

export type MemoryScope = "agent" | "swarm";
export type MemoryScopeFilter = MemoryScope | "all";
export type MemorySource = "manual" | "file_index" | "session_summary" | "task_completion";

export interface MemoryListRequest {
  query?: string;
  agentId?: string;
  scope?: MemoryScopeFilter;
  source?: MemorySource;
  sourcePath?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryEntry {
  id: string;
  name: string;
  content: string;
  agentId: string | null;
  scope: MemoryScope;
  source: MemorySource;
  similarity?: number;
  createdAt: string;
  accessedAt: string;
  accessCount: number;
  expiresAt: string | null;
  embeddingModel: string | null;
  sourceTaskId: string | null;
  sourcePath: string | null;
  chunkIndex: number;
  totalChunks: number;
  tags: string[];
}

export interface MemoryListResponse {
  results: MemoryEntry[];
  total: number;
  limit?: number;
  offset?: number;
  mode: "semantic" | "list";
}

// ─── /status (Phase 1: cloud personalization) ──────────────────────────────

export type SetupMilestoneState = "unverified" | "configured" | "verified";

export type MilestoneId =
  | "harness"
  | "slack"
  | "github"
  | "linear"
  | "jira"
  | "workers"
  | "first_task";

export interface SetupMilestone {
  id: MilestoneId;
  label: string;
  state: SetupMilestoneState;
  hint?: string;
  action_url?: string;
  /**
   * Phase 1.5: only the `harness` milestone populates this. The UI uses
   * it directly (no hint-string regex). Undefined when HARNESS_PROVIDER
   * is unset or unknown.
   */
  provider?: ProviderName;
}

export interface StatusIdentity {
  name: string;
  logo_url: string | null;
  brand_color: string | null;
  is_cloud: boolean;
  marketing_url: string | null;
  hide_cloud_promo: boolean;
  /** Stable org/tenant identifier (set via `SWARM_ORG_ID`); null on self-host. */
  org_id: string | null;
}

export interface StatusActivity {
  agents_online: number;
  leads_online: number;
  recent_tasks_count: number;
}

export interface StatusAgentFs {
  configured: boolean;
  base_url: string | null;
}

/**
 * Phase 2: Aggregate health rolled up server-side from the setup milestones.
 * Drives the always-on header badge color.
 */
export type StatusHealth = "ok" | "degraded" | "broken";

export interface StatusResponse {
  identity: StatusIdentity;
  setup: SetupMilestone[];
  activity: StatusActivity;
  agent_fs: StatusAgentFs;
  /** Phase 2: rolled-up health for the always-on header badge. */
  health: StatusHealth;
}

export interface TestConnectionResponse {
  ok: boolean;
  error?: string;
  latency_ms: number;
}

// ─── Pages (DB-backed artifacts) ──────────────────────────────────────────────

export type PageContentType = "text/html" | "application/json";
export type PageAuthMode = "public" | "authed" | "password";

/**
 * Response shape from `GET /p/:id.json` — current head state of a page (no
 * version history). Mirrors `pages-public.ts` JSON response. `passwordHash`
 * and `agentId` are intentionally NOT exposed by the server.
 */
export interface PageMetadata {
  id: string;
  version: number;
  title: string;
  description: string | null;
  contentType: PageContentType;
  authMode: PageAuthMode;
  body: string;
}

/**
 * Public view-count payload — the page-public JSON path doesn't expose
 * `viewCount` (it would imply re-rendering every time view_count changes,
 * which would defeat any caching downstream). Listing and detail endpoints
 * do expose it.
 */

/**
 * Row shape returned by `GET /api/pages` (authed listing endpoint). Server
 * decorates each row with `app_url` + `api_url`. Unlike `PageMetadata` this
 * one exposes `agentId` (the listing is bearer-gated, so the creator is
 * visible) — used by the SPA's `/pages` page for the "My pages only" toggle.
 */
export interface PageListItem {
  id: string;
  agentId: string;
  slug: string;
  title: string;
  description?: string;
  contentType: PageContentType;
  authMode: PageAuthMode;
  body: string;
  needsCredentials?: string[];
  viewCount: number;
  createdAt: string;
  updatedAt: string;
  app_url: string;
  api_url: string;
}

export interface PagesListResponse {
  pages: PageListItem[];
  total: number;
}

export type MetricVisualization = "stat" | "table" | "bar" | "line" | "multi-bar" | "multi-line";
export type MetricFormat = "number" | "integer" | "currency" | "percent" | "duration";
export type MetricParam = string | number | boolean | null;
export type MetricVariableType = "text" | "number" | "select";

export interface MetricVariable {
  key: string;
  label?: string;
  type?: MetricVariableType;
  defaultValue?: MetricParam;
  options?: Array<{
    label: string;
    value: MetricParam;
  }>;
  optionsQuery?: {
    sql: string;
    valueKey: string;
    labelKey?: string;
  };
}

export interface MetricVizColumn {
  key: string;
  label?: string;
  format?: MetricFormat;
}

export interface MetricWidget {
  id: string;
  title: string;
  description?: string;
  query: {
    sql: string;
    params?: Array<string | number | boolean | null>;
    maxRows?: number;
  };
  viz: {
    type: MetricVisualization;
    x?: string;
    y?: string;
    series?: string[];
    label?: string;
    value?: string;
    columns?: MetricVizColumn[];
    format?: MetricFormat;
  };
  colSpan?: number;
  rowSpan?: number;
}

export interface MetricDefinition {
  version: 1;
  widgets: MetricWidget[];
  variables?: MetricVariable[];
  layout?: {
    columns?: number;
  };
  refreshSeconds?: number;
}

export interface Metric {
  id: string;
  agentId: string;
  slug: string;
  title: string;
  description?: string;
  definition: MetricDefinition;
  createdAt: string;
  updatedAt: string;
}

export type MetricListItem = Omit<Metric, "definition"> & { definition?: MetricDefinition };

export interface MetricsListResponse {
  metrics: MetricListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface MetricRunResult {
  metric: Metric;
  variables?: Record<string, MetricParam>;
  widgets: Array<{
    widget: MetricWidget;
    result: {
      columns: string[];
      rows: Record<string, unknown>[];
      elapsed: number;
      total: number;
      truncated: boolean;
      maxRows: number;
    };
  }>;
  /** First widget result, kept for older callers during rollout. */
  result: {
    columns: string[];
    rows: Record<string, unknown>[];
    elapsed: number;
    total: number;
    truncated: boolean;
    maxRows: number;
  };
}

export interface MetricSaveInput {
  slug?: string;
  title: string;
  description?: string | null;
  definition: MetricDefinition;
}

export interface MetricSaveResponse {
  id: string;
  version: number;
}

/**
 * Lightweight swarm-wide counts from `GET /api/metrics` (API >= the
 * generic-metrics release). Pure `COUNT(*)` aggregates — no cost/usage data.
 * Older API servers don't expose this route; the client returns `null` for a
 * 404 so consumers hide the indicators rather than erroring.
 */
export interface SwarmMetrics {
  tasks: { total: number; by_status: Record<string, number> };
  agents: { total: number; by_status: Record<string, number> };
  workflows: { total: number; enabled: number };
  pages: { total: number };
  sessions: { active: number };
  skills: { total: number };
}
