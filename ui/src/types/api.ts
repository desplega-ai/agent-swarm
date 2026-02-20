// Backend types (mirrored from cc-orch-mcp/src/types.ts)
export type AgentStatus = "idle" | "busy" | "offline";
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
export type AgentTaskSource = "mcp" | "slack" | "api";
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
  maxTasks?: number;
  capacity?: {
    current: number;
    max: number;
    available: number;
  };
  createdAt: string;
  lastUpdatedAt: string;
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
}

export interface AgentWithTasks extends Agent {
  tasks: AgentTask[];
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

// Alias for consistency with plan
export type TaskStatus = AgentTaskStatus;
export type Stats = DashboardStats;

// API Response wrappers
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

// Service Types
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

// Session Cost Types (for Usage/Cost Tracking)
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

// Aggregated usage types for UI
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

// Scheduled Task Types
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
  createdAt: string;
  lastUpdatedAt: string;
}

export interface ScheduledTasksResponse {
  scheduledTasks: ScheduledTask[];
}

// Epic Types
export type EpicStatus = "draft" | "active" | "paused" | "completed" | "cancelled";

export interface Epic {
  id: string;
  name: string;
  description?: string;
  goal: string;
  prd?: string;
  plan?: string;
  status: EpicStatus;
  priority: number;
  tags: string[];
  createdByAgentId?: string;
  leadAgentId?: string;
  channelId?: string;
  researchDocPath?: string;
  planDocPath?: string;
  slackChannelId?: string;
  slackThreadTs?: string;
  githubRepo?: string;
  githubMilestone?: string;
  createdAt: string;
  lastUpdatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface EpicTaskStats {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  pending: number;
}

export interface EpicWithProgress extends Epic {
  taskStats: EpicTaskStats;
  progress: number;
}

export interface EpicWithTasks extends EpicWithProgress {
  tasks: AgentTask[];
}

export interface EpicsResponse {
  epics: Epic[];
  total: number;
}

// Swarm Config Types (Centralized Environment/Config Management)
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
}

export interface SwarmConfigsResponse {
  configs: SwarmConfig[];
}

// Swarm Repo Types (Centralized Repository Management)
export interface SwarmRepo {
  id: string;
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: boolean;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface SwarmReposResponse {
  repos: SwarmRepo[];
}
