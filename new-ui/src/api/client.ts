import { getConfig } from "@/lib/config";
import type {
  AgentMcpServersResponse,
  AgentSkillsResponse,
  AgentsResponse,
  AgentWithTasks,
  ApiKeyStatusResponse,
  ApprovalRequest,
  ApprovalRequestsResponse,
  Budget,
  BudgetRefusalsResponse,
  BudgetScope,
  BudgetsResponse,
  ChannelMessage,
  ChannelsResponse,
  DashboardCostResponse,
  EventDefinition,
  LogsResponse,
  McpOAuthMetadataResponse,
  McpOAuthStatusResponse,
  McpServer,
  McpServersResponse,
  MessagesResponse,
  PreviewResponse,
  PricingProvider,
  PricingResponse,
  PricingRow,
  PricingTokenClass,
  PromptTemplate,
  PromptTemplateHistory,
  ScheduledTask,
  ScheduledTasksResponse,
  ServicesResponse,
  SessionCostsResponse,
  SessionLog,
  SessionLogsResponse,
  Skill,
  SkillsResponse,
  Stats,
  SwarmConfig,
  SwarmConfigsResponse,
  SwarmRepo,
  SwarmReposResponse,
  TaskContextResponse,
  TasksResponse,
  TaskWithLogs,
  UpsertPromptTemplateInput,
  UsageSummaryResponse,
  Workflow,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowRunWithSteps,
  WorkflowsResponse,
  WorkflowVersion,
} from "./types";

class ApiClient {
  private getHeaders(): HeadersInit {
    const config = getConfig();
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    return headers;
  }

  private getBaseUrl(): string {
    const config = getConfig();
    if (import.meta.env.DEV && config.apiUrl === "http://localhost:3013") {
      return "";
    }
    return config.apiUrl;
  }

  async fetchAgents(includeTasks = true): Promise<AgentsResponse> {
    const url = `${this.getBaseUrl()}/api/agents${includeTasks ? "?include=tasks" : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
    return res.json();
  }

  async fetchAgent(id: string, includeTasks = true): Promise<AgentWithTasks> {
    const url = `${this.getBaseUrl()}/api/agents/${id}${includeTasks ? "?include=tasks" : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch agent: ${res.status}`);
    return res.json();
  }

  async updateAgentName(id: string, name: string): Promise<AgentWithTasks> {
    const url = `${this.getBaseUrl()}/api/agents/${id}/name`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to update name" }));
      throw new Error(error.error || `Failed to update name: ${res.status}`);
    }
    return res.json();
  }

  async updateAgentProfile(
    id: string,
    profile: {
      role?: string;
      description?: string;
      capabilities?: string[];
      claudeMd?: string;
      soulMd?: string;
      identityMd?: string;
      toolsMd?: string;
      setupScript?: string;
      heartbeatMd?: string;
    },
  ): Promise<AgentWithTasks> {
    const url = `${this.getBaseUrl()}/api/agents/${id}/profile`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(profile),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to update profile" }));
      throw new Error(error.error || `Failed to update profile: ${res.status}`);
    }
    return res.json();
  }

  async fetchTasks(filters?: {
    status?: string;
    agentId?: string;
    scheduleId?: string;
    search?: string;
    includeHeartbeat?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<TasksResponse> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.scheduleId) params.set("scheduleId", filters.scheduleId);
    if (filters?.search) params.set("search", filters.search);
    if (filters?.includeHeartbeat) params.set("includeHeartbeat", "true");
    if (filters?.limit != null) params.set("limit", String(filters.limit));
    if (filters?.offset != null) params.set("offset", String(filters.offset));
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/tasks${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
    return res.json();
  }

  async fetchTask(id: string): Promise<TaskWithLogs> {
    const url = `${this.getBaseUrl()}/api/tasks/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch task: ${res.status}`);
    return res.json();
  }

  async createTask(data: {
    task: string;
    agentId?: string;
    taskType?: string;
    tags?: string[];
    priority?: number;
    dependsOn?: string[];
  }): Promise<TaskWithLogs> {
    const url = `${this.getBaseUrl()}/api/tasks`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to create task" }));
      throw new Error(error.error || `Failed to create task: ${res.status}`);
    }
    return res.json();
  }

  async cancelTask(id: string, reason?: string): Promise<{ success: boolean; task: TaskWithLogs }> {
    const url = `${this.getBaseUrl()}/api/tasks/${id}/cancel`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to cancel task" }));
      throw new Error(error.error || `Failed to cancel task: ${res.status}`);
    }
    return res.json();
  }

  async pauseTask(id: string): Promise<{ success: boolean; task: TaskWithLogs }> {
    const url = `${this.getBaseUrl()}/api/tasks/${id}/pause`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to pause task" }));
      throw new Error(error.error || `Failed to pause task: ${res.status}`);
    }
    return res.json();
  }

  async resumeTask(id: string): Promise<{ success: boolean; task: TaskWithLogs }> {
    const url = `${this.getBaseUrl()}/api/tasks/${id}/resume`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to resume task" }));
      throw new Error(error.error || `Failed to resume task: ${res.status}`);
    }
    return res.json();
  }

  async fetchTaskSessionLogs(taskId: string): Promise<SessionLog[]> {
    const url = `${this.getBaseUrl()}/api/tasks/${taskId}/session-logs`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch session logs: ${res.status}`);
    const data = (await res.json()) as SessionLogsResponse;
    return data.logs;
  }

  async fetchTaskContext(taskId: string): Promise<TaskContextResponse> {
    const url = `${this.getBaseUrl()}/api/tasks/${taskId}/context`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch task context: ${res.status}`);
    return res.json();
  }

  async fetchLogs(limit = 100, agentId?: string): Promise<LogsResponse> {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (agentId) params.set("agentId", agentId);
    const url = `${this.getBaseUrl()}/api/logs?${params.toString()}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch logs: ${res.status}`);
    return res.json();
  }

  async fetchStats(): Promise<Stats> {
    const url = `${this.getBaseUrl()}/api/stats`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
    return res.json();
  }

  async checkHealth(): Promise<{ status: string; version: string }> {
    const config = getConfig();
    const baseUrl =
      import.meta.env.DEV && config.apiUrl === "http://localhost:3013"
        ? "http://localhost:3013"
        : config.apiUrl;
    const url = `${baseUrl}/health`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return res.json();
  }

  async createChannel(data: {
    name: string;
    description?: string;
    type?: string;
  }): Promise<{ channel: { id: string; name: string } }> {
    const url = `${this.getBaseUrl()}/api/channels`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to create channel: ${res.status}`);
    }
    return res.json();
  }

  async deleteChannel(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/channels/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to delete channel: ${res.status}`);
    }
    return res.json();
  }

  async fetchChannels(): Promise<ChannelsResponse> {
    const url = `${this.getBaseUrl()}/api/channels`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch channels: ${res.status}`);
    return res.json();
  }

  async fetchMessages(
    channelId: string,
    options?: { limit?: number; since?: string; before?: string },
  ): Promise<MessagesResponse> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.since) params.set("since", options.since);
    if (options?.before) params.set("before", options.before);
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/channels/${channelId}/messages${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
    return res.json();
  }

  async fetchThreadMessages(channelId: string, messageId: string): Promise<MessagesResponse> {
    const url = `${this.getBaseUrl()}/api/channels/${channelId}/messages/${messageId}/thread`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch thread: ${res.status}`);
    return res.json();
  }

  async postMessage(
    channelId: string,
    content: string,
    options?: { agentId?: string; replyToId?: string; mentions?: string[] },
  ): Promise<ChannelMessage> {
    const url = `${this.getBaseUrl()}/api/channels/${channelId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        content,
        agentId: options?.agentId,
        replyToId: options?.replyToId,
        mentions: options?.mentions,
      }),
    });
    if (!res.ok) throw new Error(`Failed to post message: ${res.status}`);
    return res.json();
  }

  async fetchServices(filters?: {
    status?: string;
    agentId?: string;
    name?: string;
  }): Promise<ServicesResponse> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.name) params.set("name", filters.name);
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/services${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch services: ${res.status}`);
    return res.json();
  }

  async fetchSessionCosts(filters?: {
    agentId?: string;
    taskId?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<SessionCostsResponse> {
    const params = new URLSearchParams();
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.taskId) params.set("taskId", filters.taskId);
    if (filters?.startDate) params.set("startDate", filters.startDate);
    if (filters?.endDate) params.set("endDate", filters.endDate);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/session-costs${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch session costs: ${res.status}`);
    return res.json();
  }

  async fetchUsageSummary(filters?: {
    startDate?: string;
    endDate?: string;
    agentId?: string;
    groupBy?: "day" | "agent" | "both";
  }): Promise<UsageSummaryResponse> {
    const params = new URLSearchParams();
    if (filters?.startDate) params.set("startDate", filters.startDate);
    if (filters?.endDate) params.set("endDate", filters.endDate);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.groupBy) params.set("groupBy", filters.groupBy);
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/session-costs/summary${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch usage summary: ${res.status}`);
    return res.json();
  }

  async fetchDashboardCosts(): Promise<DashboardCostResponse> {
    const url = `${this.getBaseUrl()}/api/session-costs/dashboard`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch dashboard costs: ${res.status}`);
    return res.json();
  }

  async fetchScheduledTasks(filters?: {
    enabled?: boolean;
    name?: string;
  }): Promise<ScheduledTasksResponse> {
    const params = new URLSearchParams();
    if (filters?.enabled !== undefined) params.set("enabled", String(filters.enabled));
    if (filters?.name) params.set("name", filters.name);
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/scheduled-tasks${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch scheduled tasks: ${res.status}`);
    return res.json();
  }

  async fetchSchedule(id: string): Promise<ScheduledTask> {
    const url = `${this.getBaseUrl()}/api/schedules/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch schedule: ${res.status}`);
    return res.json();
  }

  async createSchedule(data: {
    name: string;
    taskTemplate: string;
    cronExpression?: string;
    intervalMs?: number;
    description?: string;
    taskType?: string;
    tags?: string[];
    priority?: number;
    targetAgentId?: string;
    timezone?: string;
    model?: string;
    enabled?: boolean;
  }): Promise<ScheduledTask> {
    const url = `${this.getBaseUrl()}/api/schedules`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.getHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to create schedule: ${res.status}`);
    }
    return res.json();
  }

  async updateSchedule(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask> {
    const url = `${this.getBaseUrl()}/api/schedules/${id}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...this.getHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to update schedule: ${res.status}`);
    }
    return res.json();
  }

  async deleteSchedule(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/schedules/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to delete schedule: ${res.status}`);
    }
    return res.json();
  }

  async runScheduleNow(id: string): Promise<{ schedule: ScheduledTask; task: TaskWithLogs }> {
    const url = `${this.getBaseUrl()}/api/schedules/${id}/run`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to run schedule: ${res.status}`);
    }
    return res.json();
  }

  async fetchConfigs(filters?: {
    scope?: string;
    scopeId?: string;
    includeSecrets?: boolean;
  }): Promise<SwarmConfigsResponse> {
    const params = new URLSearchParams();
    if (filters?.scope) params.set("scope", filters.scope);
    if (filters?.scopeId) params.set("scopeId", filters.scopeId);
    if (filters?.includeSecrets) params.set("includeSecrets", "true");
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/config${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch configs: ${res.status}`);
    return res.json();
  }

  async fetchResolvedConfig(params?: {
    agentId?: string;
    repoId?: string;
    includeSecrets?: boolean;
  }): Promise<SwarmConfigsResponse> {
    const searchParams = new URLSearchParams();
    if (params?.agentId) searchParams.set("agentId", params.agentId);
    if (params?.repoId) searchParams.set("repoId", params.repoId);
    if (params?.includeSecrets) searchParams.set("includeSecrets", "true");
    const queryString = searchParams.toString();
    const url = `${this.getBaseUrl()}/api/config/resolved${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch resolved config: ${res.status}`);
    return res.json();
  }

  async upsertConfig(data: {
    scope: string;
    scopeId?: string | null;
    key: string;
    value: string;
    isSecret?: boolean;
    envPath?: string | null;
    description?: string | null;
  }): Promise<SwarmConfig> {
    const url = `${this.getBaseUrl()}/api/config?includeSecrets=true`;
    const cleaned = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== null));
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(cleaned),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to upsert config" }));
      throw new Error(error.error || `Failed to upsert config: ${res.status}`);
    }
    return res.json();
  }

  async deleteConfig(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/config/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to delete config: ${res.status}`);
    return res.json();
  }

  async fetchRepo(id: string): Promise<SwarmRepo> {
    const url = `${this.getBaseUrl()}/api/repos/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch repo: ${res.status}`);
    return res.json();
  }

  async fetchRepos(filters?: { autoClone?: boolean }): Promise<SwarmReposResponse> {
    const params = new URLSearchParams();
    if (filters?.autoClone !== undefined) params.set("autoClone", String(filters.autoClone));
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/repos${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch repos: ${res.status}`);
    return res.json();
  }

  async createRepo(data: {
    url: string;
    name: string;
    clonePath?: string;
    defaultBranch?: string;
    autoClone?: boolean;
  }): Promise<SwarmRepo> {
    const url = `${this.getBaseUrl()}/api/repos`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to create repo" }));
      throw new Error(error.error || `Failed to create repo: ${res.status}`);
    }
    return res.json();
  }

  async updateRepo(
    id: string,
    data: Partial<{
      url: string;
      name: string;
      clonePath: string;
      defaultBranch: string;
      autoClone: boolean;
      guidelines: import("./types").RepoGuidelines | null;
    }>,
  ): Promise<SwarmRepo> {
    const url = `${this.getBaseUrl()}/api/repos/${id}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to update repo" }));
      throw new Error(error.error || `Failed to update repo: ${res.status}`);
    }
    return res.json();
  }

  async deleteRepo(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/repos/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to delete repo: ${res.status}`);
    return res.json();
  }
  // Workflows
  async fetchWorkflows(): Promise<WorkflowsResponse> {
    const url = `${this.getBaseUrl()}/api/workflows`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch workflows: ${res.status}`);
    const workflows = (await res.json()) as Workflow[];
    // List endpoint doesn't include auto-generated edges — ensure the field exists
    for (const w of workflows) {
      if (!w.definition.edges) {
        w.definition.edges = [];
      }
    }
    return { workflows };
  }

  async fetchWorkflow(id: string): Promise<Workflow> {
    const url = `${this.getBaseUrl()}/api/workflows/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch workflow: ${res.status}`);
    const data = await res.json();
    // API returns { ...workflow, edges } with edges at top level.
    // Nest edges into definition for UI convenience.
    if (data.edges && !data.definition.edges) {
      data.definition.edges = data.edges;
    }
    // Ensure edges array exists even if not returned
    if (!data.definition.edges) {
      data.definition.edges = [];
    }
    return data as Workflow;
  }

  async updateWorkflow(
    id: string,
    data: Partial<Pick<Workflow, "name" | "description" | "enabled">>,
  ): Promise<Workflow> {
    const url = `${this.getBaseUrl()}/api/workflows/${id}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to update workflow: ${res.status}`);
    return res.json();
  }

  async deleteWorkflow(id: string): Promise<void> {
    const url = `${this.getBaseUrl()}/api/workflows/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to delete workflow: ${res.status}`);
  }

  async triggerWorkflow(
    id: string,
    triggerData?: Record<string, unknown>,
  ): Promise<{ runId: string }> {
    const url = `${this.getBaseUrl()}/api/workflows/${id}/trigger`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ triggerData }),
    });
    if (!res.ok) throw new Error(`Failed to trigger workflow: ${res.status}`);
    return res.json();
  }

  async fetchWorkflowRuns(workflowId: string): Promise<WorkflowRun[]> {
    const url = `${this.getBaseUrl()}/api/workflows/${workflowId}/runs`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch workflow runs: ${res.status}`);
    return res.json();
  }

  async fetchAllWorkflowRuns(): Promise<WorkflowRun[]> {
    const { workflows } = await this.fetchWorkflows();
    const allRuns: WorkflowRun[] = [];
    for (const w of workflows) {
      const runs = await this.fetchWorkflowRuns(w.id);
      allRuns.push(...runs);
    }
    return allRuns.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }

  async fetchWorkflowRun(id: string): Promise<WorkflowRunWithSteps> {
    const url = `${this.getBaseUrl()}/api/workflow-runs/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch workflow run: ${res.status}`);
    const data = (await res.json()) as { run: WorkflowRun; steps: WorkflowRunStep[] };
    // Reshape { run, steps } into WorkflowRunWithSteps
    return { ...data.run, steps: data.steps };
  }

  async fetchWorkflowVersions(workflowId: string): Promise<WorkflowVersion[]> {
    const url = `${this.getBaseUrl()}/api/workflows/${workflowId}/versions`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch workflow versions: ${res.status}`);
    const data = (await res.json()) as { versions: WorkflowVersion[] };
    return data.versions;
  }

  async retryWorkflowRun(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/workflow-runs/${id}/retry`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to retry workflow run: ${res.status}`);
    return res.json();
  }

  async fetchExecutorTypes(): Promise<ExecutorTypeInfo[]> {
    const url = `${this.getBaseUrl()}/api/executor-types`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.executorTypes ?? [];
  }

  async fetchExecutorType(type: string): Promise<ExecutorTypeInfo | null> {
    const url = `${this.getBaseUrl()}/api/executor-types/${encodeURIComponent(type)}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) return null;
    return res.json();
  }

  async dbQuery(sql: string, params?: unknown[]): Promise<import("./types").DbQueryResponse> {
    const url = `${this.getBaseUrl()}/api/db-query`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ sql, params }),
    });
    if (!res.ok) throw new Error(`Failed to execute query: ${res.status}`);
    return res.json();
  }

  // Prompt Templates

  async fetchPromptTemplates(filters?: {
    eventType?: string;
    scope?: string;
    isDefault?: boolean;
  }): Promise<{ templates: PromptTemplate[] }> {
    const params = new URLSearchParams();
    if (filters?.eventType) params.set("eventType", filters.eventType);
    if (filters?.scope) params.set("scope", filters.scope);
    if (filters?.isDefault !== undefined) params.set("isDefault", String(filters.isDefault));
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/prompt-templates${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch prompt templates: ${res.status}`);
    return res.json();
  }

  async fetchPromptTemplate(
    id: string,
  ): Promise<{ template: PromptTemplate; history: PromptTemplateHistory[] }> {
    const url = `${this.getBaseUrl()}/api/prompt-templates/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch prompt template: ${res.status}`);
    return res.json();
  }

  async fetchPromptTemplateEvents(): Promise<{ events: EventDefinition[] }> {
    const url = `${this.getBaseUrl()}/api/prompt-templates/events`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch prompt template events: ${res.status}`);
    return res.json();
  }

  async previewPromptTemplate(data: {
    eventType: string;
    body?: string;
    variables?: Record<string, unknown>;
  }): Promise<PreviewResponse> {
    const url = `${this.getBaseUrl()}/api/prompt-templates/preview`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to preview template" }));
      throw new Error(error.error || `Failed to preview template: ${res.status}`);
    }
    return res.json();
  }

  async renderPromptTemplate(data: {
    eventType: string;
    variables?: Record<string, unknown>;
    agentId?: string;
    repoId?: string;
  }): Promise<import("./types").RenderResponse> {
    const url = `${this.getBaseUrl()}/api/prompt-templates/render`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      throw new Error(`Failed to render prompt template: ${res.status}`);
    }
    return res.json();
  }

  async upsertPromptTemplate(data: UpsertPromptTemplateInput): Promise<PromptTemplate> {
    const url = `${this.getBaseUrl()}/api/prompt-templates`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to upsert prompt template" }));
      throw new Error(error.error || `Failed to upsert prompt template: ${res.status}`);
    }
    return res.json();
  }

  async checkoutPromptTemplate(id: string, version: number): Promise<PromptTemplate> {
    const url = `${this.getBaseUrl()}/api/prompt-templates/${id}/checkout`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ version }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to checkout prompt template" }));
      throw new Error(error.error || `Failed to checkout prompt template: ${res.status}`);
    }
    return res.json();
  }

  async resetPromptTemplate(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/prompt-templates/${id}/reset`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to reset prompt template" }));
      throw new Error(error.error || `Failed to reset prompt template: ${res.status}`);
    }
    return res.json();
  }

  async deletePromptTemplate(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/prompt-templates/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to delete prompt template" }));
      throw new Error(error.error || `Failed to delete prompt template: ${res.status}`);
    }
    return res.json();
  }

  // Approval Requests

  async fetchApprovalRequests(filters?: {
    status?: string;
    workflowRunId?: string;
    limit?: number;
  }): Promise<ApprovalRequestsResponse> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.workflowRunId) params.set("workflowRunId", filters.workflowRunId);
    if (filters?.limit != null) params.set("limit", String(filters.limit));
    const qs = params.toString();
    const url = `${this.getBaseUrl()}/api/approval-requests${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch approval requests: ${res.status}`);
    return res.json();
  }

  async fetchApprovalRequest(id: string): Promise<{ approvalRequest: ApprovalRequest }> {
    const url = `${this.getBaseUrl()}/api/approval-requests/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch approval request: ${res.status}`);
    return res.json();
  }

  async respondToApprovalRequest(
    id: string,
    responses: Record<string, unknown>,
    respondedBy?: string,
  ): Promise<{ approvalRequest: ApprovalRequest }> {
    const url = `${this.getBaseUrl()}/api/approval-requests/${id}/respond`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ responses, respondedBy }),
    });
    if (!res.ok) throw new Error(`Failed to respond to approval request: ${res.status}`);
    return res.json();
  }

  // Skills
  async fetchSkills(filters?: {
    type?: string;
    scope?: string;
    agentId?: string;
    enabled?: string;
    search?: string;
  }): Promise<SkillsResponse> {
    const params = new URLSearchParams();
    if (filters?.type) params.set("type", filters.type);
    if (filters?.scope) params.set("scope", filters.scope);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.enabled) params.set("enabled", filters.enabled);
    if (filters?.search) params.set("search", filters.search);
    const qs = params.toString();
    const url = `${this.getBaseUrl()}/api/skills${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch skills: ${res.status}`);
    return res.json();
  }

  async fetchSkill(id: string): Promise<Skill> {
    const url = `${this.getBaseUrl()}/api/skills/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status}`);
    return res.json();
  }

  async createSkill(data: {
    content: string;
    type?: string;
    scope?: string;
    ownerAgentId?: string;
  }): Promise<{ skill: Skill }> {
    const url = `${this.getBaseUrl()}/api/skills`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to create skill" }));
      throw new Error(error.error || `Failed to create skill: ${res.status}`);
    }
    return res.json();
  }

  async updateSkill(id: string, data: Record<string, unknown>): Promise<{ skill: Skill }> {
    const url = `${this.getBaseUrl()}/api/skills/${id}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to update skill" }));
      throw new Error(error.error || `Failed to update skill: ${res.status}`);
    }
    return res.json();
  }

  async deleteSkill(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/skills/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to delete skill: ${res.status}`);
    return res.json();
  }

  async installSkill(skillId: string, agentId: string): Promise<unknown> {
    const url = `${this.getBaseUrl()}/api/skills/${skillId}/install`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ agentId }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to install skill" }));
      throw new Error(error.error || `Failed to install skill: ${res.status}`);
    }
    return res.json();
  }

  async uninstallSkill(skillId: string, agentId: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/skills/${skillId}/install/${agentId}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to uninstall skill: ${res.status}`);
    return res.json();
  }

  async fetchAgentSkills(agentId: string): Promise<AgentSkillsResponse> {
    const url = `${this.getBaseUrl()}/api/agents/${agentId}/skills`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch agent skills: ${res.status}`);
    return res.json();
  }

  async installRemoteSkill(data: {
    sourceRepo: string;
    sourcePath?: string;
    scope?: string;
    isComplex?: boolean;
  }): Promise<{ skill: Skill }> {
    const url = `${this.getBaseUrl()}/api/skills/install-remote`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to install remote skill" }));
      throw new Error(error.error || `Failed to install remote skill: ${res.status}`);
    }
    return res.json();
  }

  async syncRemoteSkills(options?: {
    skillId?: string;
    force?: boolean;
  }): Promise<{ updated: number; checked: number; errors: string[] }> {
    const url = `${this.getBaseUrl()}/api/skills/sync-remote`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(options || {}),
    });
    if (!res.ok) throw new Error(`Failed to sync remote skills: ${res.status}`);
    return res.json();
  }

  // ─── MCP Servers ──────────────────────────────────────────────────────────

  async fetchMcpServers(filters?: {
    scope?: string;
    transport?: string;
    ownerAgentId?: string;
    enabled?: string;
    search?: string;
  }): Promise<McpServersResponse> {
    const params = new URLSearchParams();
    if (filters?.scope) params.set("scope", filters.scope);
    if (filters?.transport) params.set("transport", filters.transport);
    if (filters?.ownerAgentId) params.set("ownerAgentId", filters.ownerAgentId);
    if (filters?.enabled) params.set("enabled", filters.enabled);
    if (filters?.search) params.set("search", filters.search);
    const qs = params.toString();
    const url = `${this.getBaseUrl()}/api/mcp-servers${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch MCP servers: ${res.status}`);
    return res.json();
  }

  async fetchMcpServer(id: string): Promise<McpServer> {
    const url = `${this.getBaseUrl()}/api/mcp-servers/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch MCP server: ${res.status}`);
    return res.json();
  }

  async createMcpServer(data: {
    name: string;
    transport: string;
    description?: string;
    scope?: string;
    ownerAgentId?: string;
    command?: string;
    args?: string;
    url?: string;
    headers?: string;
    envConfigKeys?: string;
    headerConfigKeys?: string;
  }): Promise<{ server: McpServer }> {
    const url = `${this.getBaseUrl()}/api/mcp-servers`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to create MCP server" }));
      throw new Error(error.error || `Failed to create MCP server: ${res.status}`);
    }
    return res.json();
  }

  async updateMcpServer(id: string, data: Record<string, unknown>): Promise<{ server: McpServer }> {
    const url = `${this.getBaseUrl()}/api/mcp-servers/${id}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to update MCP server" }));
      throw new Error(error.error || `Failed to update MCP server: ${res.status}`);
    }
    return res.json();
  }

  async deleteMcpServer(id: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/mcp-servers/${id}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to delete MCP server: ${res.status}`);
    return res.json();
  }

  async installMcpServer(serverId: string, agentId: string): Promise<unknown> {
    const url = `${this.getBaseUrl()}/api/mcp-servers/${serverId}/install`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ agentId }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Failed to install MCP server" }));
      throw new Error(error.error || `Failed to install MCP server: ${res.status}`);
    }
    return res.json();
  }

  async uninstallMcpServer(serverId: string, agentId: string): Promise<{ success: boolean }> {
    const url = `${this.getBaseUrl()}/api/mcp-servers/${serverId}/install/${agentId}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to uninstall MCP server: ${res.status}`);
    return res.json();
  }

  async fetchApiKeyStatuses(keyType?: string): Promise<ApiKeyStatusResponse> {
    const params = new URLSearchParams();
    if (keyType) params.set("keyType", keyType);
    const qs = params.toString();
    const url = `${this.getBaseUrl()}/api/keys/status${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch API key statuses: ${res.status}`);
    return res.json();
  }

  async fetchApiKeyCosts(keyType?: string): Promise<import("./types").KeyCostResponse> {
    const params = new URLSearchParams();
    if (keyType) params.set("keyType", keyType);
    const qs = params.toString();
    const url = `${this.getBaseUrl()}/api/keys/costs${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch API key costs: ${res.status}`);
    return res.json();
  }

  async setApiKeyName(args: {
    keyType: string;
    keySuffix: string;
    name: string | null;
    scope?: string;
    scopeId?: string;
  }): Promise<{ success: boolean; keyType: string; keySuffix: string; name: string | null }> {
    const url = `${this.getBaseUrl()}/api/keys/name`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.getHeaders(),
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to set key name" }));
      throw new Error(err.error || `Failed to set key name: ${res.status}`);
    }
    return res.json();
  }

  async fetchAgentMcpServers(agentId: string): Promise<AgentMcpServersResponse> {
    const url = `${this.getBaseUrl()}/api/agents/${agentId}/mcp-servers`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch agent MCP servers: ${res.status}`);
    return res.json();
  }

  // ─── MCP OAuth ────────────────────────────────────────────────────────────

  async fetchMcpOAuthStatus(mcpServerId: string): Promise<McpOAuthStatusResponse> {
    const url = `${this.getBaseUrl()}/api/mcp-oauth/${mcpServerId}/status`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch OAuth status: ${res.status}`);
    return res.json();
  }

  async fetchMcpOAuthMetadata(mcpServerId: string): Promise<McpOAuthMetadataResponse> {
    const url = `${this.getBaseUrl()}/api/mcp-oauth/${mcpServerId}/metadata`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to fetch OAuth metadata" }));
      throw new Error(err.error || `Failed to fetch OAuth metadata: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Fetch the OAuth provider URL for an MCP server. The caller then navigates
   * the browser to `providerUrl`.
   *
   * Using a separate authed endpoint (instead of navigating straight to
   * `/api/mcp-oauth/:id/authorize`) keeps the Bearer auth header on the API
   * call and lets the browser redirect freely to the external OAuth provider.
   */
  async fetchMcpOAuthAuthorizeUrl(
    mcpServerId: string,
    options?: { redirect?: string; scopes?: string },
  ): Promise<{ providerUrl: string }> {
    const params = new URLSearchParams();
    if (options?.redirect) params.set("redirect", options.redirect);
    if (options?.scopes) params.set("scopes", options.scopes);
    const qs = params.toString();
    const url = `${this.getBaseUrl()}/api/mcp-oauth/${mcpServerId}/authorize-url${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to start OAuth flow" }));
      throw new Error(err.error || `Failed to start OAuth flow: ${res.status}`);
    }
    return res.json();
  }

  async refreshMcpOAuthToken(
    mcpServerId: string,
  ): Promise<{ ok: boolean; expiresAt: string | null; scope: string | null }> {
    const url = `${this.getBaseUrl()}/api/mcp-oauth/${mcpServerId}/refresh`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to refresh OAuth token" }));
      throw new Error(err.error || `Failed to refresh OAuth token: ${res.status}`);
    }
    return res.json();
  }

  async disconnectMcpOAuth(mcpServerId: string): Promise<{ ok: boolean }> {
    const url = `${this.getBaseUrl()}/api/mcp-oauth/${mcpServerId}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to disconnect OAuth" }));
      throw new Error(err.error || `Failed to disconnect OAuth: ${res.status}`);
    }
    return res.json();
  }

  async registerMcpOAuthManualClient(
    mcpServerId: string,
    data: {
      clientId: string;
      clientSecret?: string;
      authorizationServerIssuer?: string;
      authorizeUrl?: string;
      tokenUrl?: string;
      revocationUrl?: string;
      scopes?: string[];
    },
  ): Promise<{ ok: boolean }> {
    const url = `${this.getBaseUrl()}/api/mcp-oauth/${mcpServerId}/manual-client`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to register manual client" }));
      throw new Error(err.error || `Failed to register manual client: ${res.status}`);
    }
    return res.json();
  }

  // ─── Budgets ───────────────────────────────────────────────────────────────

  async fetchBudgets(): Promise<BudgetsResponse> {
    const url = `${this.getBaseUrl()}/api/budgets`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch budgets: ${res.status}`);
    return res.json();
  }

  async fetchBudgetRefusals(limit?: number): Promise<BudgetRefusalsResponse> {
    const params = limit ? `?limit=${limit}` : "";
    const url = `${this.getBaseUrl()}/api/budgets/refusals${params}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch budget refusals: ${res.status}`);
    return res.json();
  }

  /** Pass scopeId="" for global; the wire format substitutes "_global". */
  async upsertBudget(scope: BudgetScope, scopeId: string, dailyBudgetUsd: number): Promise<Budget> {
    const wireScopeId = scope === "global" ? "_global" : scopeId;
    const url = `${this.getBaseUrl()}/api/budgets/${scope}/${encodeURIComponent(wireScopeId)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify({ dailyBudgetUsd }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to upsert budget" }));
      throw new Error(err.error || `Failed to upsert budget: ${res.status}`);
    }
    return res.json();
  }

  async deleteBudget(scope: BudgetScope, scopeId: string): Promise<void> {
    const wireScopeId = scope === "global" ? "_global" : scopeId;
    const url = `${this.getBaseUrl()}/api/budgets/${scope}/${encodeURIComponent(wireScopeId)}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok && res.status !== 404) {
      const err = await res.json().catch(() => ({ error: "Failed to delete budget" }));
      throw new Error(err.error || `Failed to delete budget: ${res.status}`);
    }
  }

  // ─── Pricing ───────────────────────────────────────────────────────────────

  async fetchPricing(): Promise<PricingResponse> {
    const url = `${this.getBaseUrl()}/api/pricing`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch pricing: ${res.status}`);
    return res.json();
  }

  async insertPricingRow(input: {
    provider: PricingProvider;
    model: string;
    tokenClass: PricingTokenClass;
    pricePerMillionUsd: number;
    effectiveFrom?: number;
  }): Promise<PricingRow> {
    const url = `${this.getBaseUrl()}/api/pricing/${input.provider}/${encodeURIComponent(input.model)}/${input.tokenClass}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        pricePerMillionUsd: input.pricePerMillionUsd,
        effectiveFrom: input.effectiveFrom,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed to insert pricing row" }));
      throw new Error(err.error || `Failed to insert pricing row: ${res.status}`);
    }
    return res.json();
  }

  async deletePricingRow(
    provider: PricingProvider,
    model: string,
    tokenClass: PricingTokenClass,
    effectiveFrom: number,
  ): Promise<void> {
    const url = `${this.getBaseUrl()}/api/pricing/${provider}/${encodeURIComponent(model)}/${tokenClass}/${effectiveFrom}`;
    const res = await fetch(url, { method: "DELETE", headers: this.getHeaders() });
    if (!res.ok && res.status !== 404) {
      const err = await res.json().catch(() => ({ error: "Failed to delete pricing row" }));
      throw new Error(err.error || `Failed to delete pricing row: ${res.status}`);
    }
  }
}

export interface ExecutorTypeInfo {
  type: string;
  mode: "instant" | "async";
  configSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export const api = new ApiClient();
