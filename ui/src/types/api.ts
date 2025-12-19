// Backend types (mirrored from cc-orch-mcp/src/types.ts)
export type AgentStatus = "idle" | "busy" | "offline";
export type AgentTaskStatus = "unassigned" | "offered" | "pending" | "in_progress" | "completed" | "failed";
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
