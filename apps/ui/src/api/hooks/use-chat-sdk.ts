import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

const CHAT_SDK_STATUS_KEY = ["integrations", "chat-sdk", "status"] as const;

/**
 * Chat SDK channel status: enabled flag, Slack clash, per-adapter health and
 * webhook URL. Polls every 5 s unless `poll` is false.
 */
export function useChatSdkStatus({
  enabled = true,
  poll = true,
}: {
  enabled?: boolean;
  poll?: boolean;
} = {}) {
  return useQuery({
    queryKey: CHAT_SDK_STATUS_KEY,
    queryFn: () => api.getChatSdkStatus(),
    enabled,
    refetchInterval: poll ? 5000 : false,
  });
}

/** Point the Telegram bot at this swarm's webhook URL, then read `getWebhookInfo`. */
export function useRegisterTelegramWebhook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.registerChatSdkTelegramWebhook(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CHAT_SDK_STATUS_KEY }),
  });
}

export function useInvalidateChatSdkStatus() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CHAT_SDK_STATUS_KEY });
}
