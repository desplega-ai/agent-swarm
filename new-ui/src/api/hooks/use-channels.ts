import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

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
      if (lastPage.length < pageSize) return undefined;
      const oldest = lastPage[0];
      return oldest?.createdAt;
    },
    enabled: !!channelId,
    select: (data) => {
      const allMessages = data.pages.flat();
      const seen = new Set<string>();
      const deduped = allMessages.filter((msg) => {
        if (seen.has(msg.id)) return false;
        seen.add(msg.id);
        return true;
      });
      return deduped.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
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
    mutationFn: (params: {
      content: string;
      agentId?: string;
      replyToId?: string;
      mentions?: string[];
    }) =>
      api.postMessage(channelId, params.content, {
        agentId: params.agentId,
        replyToId: params.replyToId,
        mentions: params.mentions,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["messages", channelId] });
      queryClient.invalidateQueries({ queryKey: ["infiniteMessages", channelId] });
      if (variables.replyToId) {
        queryClient.invalidateQueries({ queryKey: ["thread", channelId, variables.replyToId] });
      }
    },
  });
}
