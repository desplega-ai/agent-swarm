import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AgentWithTasks } from "../types/api";

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

export interface TaskFilters {
  status?: string;
  agentId?: string;
  search?: string;
}

export function useTasks(filters?: TaskFilters) {
  return useQuery({
    queryKey: ["tasks", filters],
    queryFn: () => api.fetchTasks(filters),
    select: (data) => data.tasks,
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.fetchTask(id),
    enabled: !!id,
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
      // Invalidate channel messages
      queryClient.invalidateQueries({ queryKey: ["messages", channelId] });
      // Also invalidate thread if this was a reply
      if (variables.replyToId) {
        queryClient.invalidateQueries({ queryKey: ["thread", channelId, variables.replyToId] });
      }
    },
  });
}
