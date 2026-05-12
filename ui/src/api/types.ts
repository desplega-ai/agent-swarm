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
  | "cancelled";
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

export interface AgentCredStatus {
  ready: boolean;
  missing: string[];
  satisfiedBy?: "env" | "file" | "side-effect-pending" | null;
  hint?: string | null;
  liveTest?: AgentCredStatusLiveTest | null;
  latestModel?: AgentLatestModel | null;
  reportedAt: number;
  reportKind?: "boot" | "post_task";
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
 * canonical row from the new `users` table.
 */
export interface User {
  id: string;
  name: string;
  email?: string;
  role?: string;
  notes?: string;
  slackUserId?: string;
  linearUserId?: string;
  githubUsername?: string;
  gitlabUsername?: string;
  emailAliases: string[];
  preferredChannel: string;
  timezone?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface UsersResponse {
  users: User[];
}

export interface CreateUserInput {
  name: string;
  email?: string;
  role?: string;
  notes?: string;
  slackUserId?: string;
  linearUserId?: string;
  githubUsername?: string;
  gitlabUsername?: string;
  emailAliases?: string[];
  preferredChannel?: string;
  timezone?: string;
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

export interface TaskWithLogs extends AgentTask {
  logs: AgentLog[];
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

export interface SessionCost {
  id: string;
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  numTurns: number;
  model: string;
  isError: boolean;
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

export interface SwarmRepo {
  id: string;
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: boolean;
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

export interface WorkflowsResponse {
  workflows: Workflow[];
}

export interface WorkflowRunsResponse {
  runs: WorkflowRun[];
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

export interface ContextSnapshot {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  contextUsedTokens?: number;
  contextTotalTokens?: number;
  contextPercent?: number;
  eventType: ContextSnapshotEventType;
  compactTrigger?: "auto" | "manual";
  preCompactTokens?: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  createdAt: string;
}

export interface ContextSummary {
  compactionCount: number;
  peakContextPercent: number | null;
  totalContextTokensUsed: number | null;
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
export type BudgetScope = "global" | "agent";

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
