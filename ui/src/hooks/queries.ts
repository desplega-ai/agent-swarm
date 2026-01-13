import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
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
