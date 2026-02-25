import type {
  AgentsResponse,
  AgentWithTasks,
  ChannelMessage,
  ChannelsResponse,
  EpicsResponse,
  EpicWithTasks,
  LogsResponse,
  MessagesResponse,
  ScheduledTasksResponse,
  ServicesResponse,
  SessionCostsResponse,
  SessionLog,
  SessionLogsResponse,
  Stats,
  SwarmConfig,
  SwarmConfigsResponse,
  SwarmRepo,
  SwarmReposResponse,
  TasksResponse,
  TaskWithLogs,
} from "./types";
import { getConfig } from "@/lib/config";

class ApiClient {
  private getHeaders(): HeadersInit {
    const config = getConfig();
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
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
    search?: string;
  }): Promise<TasksResponse> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.search) params.set("search", filters.search);
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

  async fetchTaskSessionLogs(taskId: string): Promise<SessionLog[]> {
    const url = `${this.getBaseUrl()}/api/tasks/${taskId}/session-logs`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch session logs: ${res.status}`);
    const data = (await res.json()) as SessionLogsResponse;
    return data.logs;
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
    limit?: number;
  }): Promise<SessionCostsResponse> {
    const params = new URLSearchParams();
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.taskId) params.set("taskId", filters.taskId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/session-costs${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch session costs: ${res.status}`);
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

  async fetchEpics(filters?: {
    status?: string;
    search?: string;
    leadAgentId?: string;
  }): Promise<EpicsResponse> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.search) params.set("search", filters.search);
    if (filters?.leadAgentId) params.set("leadAgentId", filters.leadAgentId);
    const queryString = params.toString();
    const url = `${this.getBaseUrl()}/api/epics${queryString ? `?${queryString}` : ""}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch epics: ${res.status}`);
    return res.json();
  }

  async fetchEpic(id: string): Promise<EpicWithTasks> {
    const url = `${this.getBaseUrl()}/api/epics/${id}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch epic: ${res.status}`);
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
    const res = await fetch(url, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(data),
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
}

export const api = new ApiClient();
