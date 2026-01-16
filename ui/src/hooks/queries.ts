import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api";
import type { AgentWithTasks, SessionCost, UsageStats } from "../types/api";

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api.fetchAgents(true),
    select: (data) => data.agents as AgentWithTasks[],
  });
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: ["agent", id],
    queryFn: () => api.fetchAgent(id),
    enabled: !!id,
  });
}

export function useUpdateAgentName() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateAgentName(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
  });
}

export function useUpdateAgentProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      profile,
    }: {
      id: string;
      profile: { role?: string; description?: string; capabilities?: string[] };
    }) => api.updateAgentProfile(id, profile),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
  });
}

export interface TaskFilters {
  status?: string;
  agentId?: string;
  search?: string;
}

export function useTasks(filters?: TaskFilters) {
  return useQuery({
    queryKey: ["tasks", filters],
    queryFn: () => api.fetchTasks(filters),
    select: (data) => ({ tasks: data.tasks, total: data.total }),
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.fetchTask(id),
    enabled: !!id,
  });
}

export function useTaskSessionLogs(taskId: string) {
  return useQuery({
    queryKey: ["task", taskId, "session-logs"],
    queryFn: () => api.fetchTaskSessionLogs(taskId),
    enabled: !!taskId,
    refetchInterval: 5000, // Refresh every 5 seconds for live updates
  });
}

export function useLogs(limit = 50, agentId?: string) {
  return useQuery({
    queryKey: ["logs", limit, agentId],
    queryFn: () => api.fetchLogs(limit, agentId),
    select: (data) => data.logs,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => api.fetchStats(),
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.checkHealth(),
    refetchInterval: 10000, // Check every 10 seconds
    retry: 2,
    retryDelay: 1000,
  });
}

export function useChannels() {
  return useQuery({
    queryKey: ["channels"],
    queryFn: () => api.fetchChannels(),
    select: (data) => data.channels,
  });
}

export interface MessageFilters {
  limit?: number;
  since?: string;
  before?: string;
}

export function useMessages(channelId: string, filters?: MessageFilters) {
  return useQuery({
    queryKey: ["messages", channelId, filters],
    queryFn: () => api.fetchMessages(channelId, filters),
    select: (data) => data.messages,
    enabled: !!channelId,
  });
}

const DEFAULT_MESSAGE_LIMIT = 100;

export function useInfiniteMessages(channelId: string, pageSize = DEFAULT_MESSAGE_LIMIT) {
  return useInfiniteQuery({
    queryKey: ["infiniteMessages", channelId],
    queryFn: async ({ pageParam }) => {
      const result = await api.fetchMessages(channelId, {
        limit: pageSize,
        before: pageParam,
      });
      return result.messages;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      // If we got fewer messages than requested, there are no more
      if (lastPage.length < pageSize) return undefined;
      // Get the oldest message's createdAt for the next page
      const oldest = lastPage[0]; // Messages are in chronological order, first is oldest
      return oldest?.createdAt;
    },
    enabled: !!channelId,
    select: (data) => {
      // Flatten all pages and dedupe by id, keeping chronological order
      const allMessages = data.pages.flat();
      const seen = new Set<string>();
      const deduped = allMessages.filter((msg) => {
        if (seen.has(msg.id)) return false;
        seen.add(msg.id);
        return true;
      });
      // Sort chronologically (oldest first)
      return deduped.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    },
  });
}

export function useThreadMessages(channelId: string, messageId: string) {
  return useQuery({
    queryKey: ["thread", channelId, messageId],
    queryFn: () => api.fetchThreadMessages(channelId, messageId),
    select: (data) => data.messages,
    enabled: !!channelId && !!messageId,
  });
}

export function usePostMessage(channelId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { content: string; agentId?: string; replyToId?: string; mentions?: string[] }) =>
      api.postMessage(channelId, params.content, {
        agentId: params.agentId,
        replyToId: params.replyToId,
        mentions: params.mentions,
      }),
    onSuccess: (_data, variables) => {
      // Invalidate channel messages (both regular and infinite)
      queryClient.invalidateQueries({ queryKey: ["messages", channelId] });
      queryClient.invalidateQueries({ queryKey: ["infiniteMessages", channelId] });
      // Also invalidate thread if this was a reply
      if (variables.replyToId) {
        queryClient.invalidateQueries({ queryKey: ["thread", channelId, variables.replyToId] });
      }
    },
  });
}

export interface ServiceFilters {
  status?: string;
  agentId?: string;
  name?: string;
}

export function useServices(filters?: ServiceFilters) {
  return useQuery({
    queryKey: ["services", filters],
    queryFn: () => api.fetchServices(filters),
    select: (data) => data.services,
  });
}

// Session Cost hooks for Usage/Cost Tracking

export interface SessionCostFilters {
  agentId?: string;
  taskId?: string;
  limit?: number;
}

export function useSessionCosts(filters?: SessionCostFilters) {
  return useQuery({
    queryKey: ["session-costs", filters],
    queryFn: () => api.fetchSessionCosts(filters),
    select: (data) => data.costs,
  });
}

// Helper function for aggregation
function aggregateUsage(costs: SessionCost[]): UsageStats {
  return {
    totalCostUsd: costs.reduce((sum, c) => sum + c.totalCostUsd, 0),
    totalTokens: costs.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0),
    inputTokens: costs.reduce((sum, c) => sum + c.inputTokens, 0),
    outputTokens: costs.reduce((sum, c) => sum + c.outputTokens, 0),
    cacheReadTokens: costs.reduce((sum, c) => sum + c.cacheReadTokens, 0),
    cacheWriteTokens: costs.reduce((sum, c) => sum + c.cacheWriteTokens, 0),
    sessionCount: costs.length,
    totalDurationMs: costs.reduce((sum, c) => sum + c.durationMs, 0),
    avgCostPerSession: costs.length > 0
      ? costs.reduce((sum, c) => sum + c.totalCostUsd, 0) / costs.length
      : 0,
  };
}

// Hook for aggregated usage stats (monthly)
export function useMonthlyUsageStats() {
  const { data: costs, ...rest } = useSessionCosts({ limit: 1000 });

  const stats = useMemo(() => {
    if (!costs) return null;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyCosts = costs.filter(
      (c) => new Date(c.createdAt) >= startOfMonth
    );

    return {
      totalCostUsd: monthlyCosts.reduce((sum, c) => sum + c.totalCostUsd, 0),
      totalTokens: monthlyCosts.reduce(
        (sum, c) => sum + c.inputTokens + c.outputTokens, 0
      ),
      inputTokens: monthlyCosts.reduce((sum, c) => sum + c.inputTokens, 0),
      outputTokens: monthlyCosts.reduce((sum, c) => sum + c.outputTokens, 0),
      cacheReadTokens: monthlyCosts.reduce((sum, c) => sum + c.cacheReadTokens, 0),
      cacheWriteTokens: monthlyCosts.reduce((sum, c) => sum + c.cacheWriteTokens, 0),
      sessionCount: monthlyCosts.length,
      totalDurationMs: monthlyCosts.reduce((sum, c) => sum + c.durationMs, 0),
      avgCostPerSession: monthlyCosts.length > 0
        ? monthlyCosts.reduce((sum, c) => sum + c.totalCostUsd, 0) / monthlyCosts.length
        : 0,
    };
  }, [costs]);

  return { data: stats, ...rest };
}

// Hook for agent usage summary
export function useAgentUsageSummary(agentId: string) {
  return useQuery({
    queryKey: ["agent-usage", agentId],
    queryFn: () => api.fetchSessionCosts({ agentId, limit: 500 }),
    select: (data) => {
      const costs = data.costs;
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const filterByDate = (start: Date) =>
        costs.filter((c) => new Date(c.createdAt) >= start);

      return {
        daily: aggregateUsage(filterByDate(startOfDay)),
        weekly: aggregateUsage(filterByDate(startOfWeek)),
        monthly: aggregateUsage(filterByDate(startOfMonth)),
        all: aggregateUsage(costs),
      };
    },
    enabled: !!agentId,
  });
}

// Hook for task usage
export function useTaskUsage(taskId: string) {
  return useQuery({
    queryKey: ["task-usage", taskId],
    queryFn: () => api.fetchSessionCosts({ taskId }),
    select: (data) => aggregateUsage(data.costs),
    enabled: !!taskId,
  });
}

// Scheduled Tasks hooks
export interface ScheduledTaskFilters {
  enabled?: boolean;
  name?: string;
}

export function useScheduledTasks(filters?: ScheduledTaskFilters) {
  return useQuery({
    queryKey: ["scheduled-tasks", filters],
    queryFn: () => api.fetchScheduledTasks(filters),
    select: (data) => data.scheduledTasks,
  });
}
