import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

export function useMcpOAuthStatus(mcpServerId: string, enabled = true) {
  return useQuery({
    queryKey: ["mcp-oauth-status", mcpServerId],
    queryFn: () => api.fetchMcpOAuthStatus(mcpServerId),
    enabled: !!mcpServerId && enabled,
    refetchOnWindowFocus: true,
  });
}

export function useMcpOAuthMetadata(mcpServerId: string, enabled = true) {
  return useQuery({
    queryKey: ["mcp-oauth-metadata", mcpServerId],
    queryFn: () => api.fetchMcpOAuthMetadata(mcpServerId),
    enabled: !!mcpServerId && enabled,
    retry: false,
  });
}

export function useStartMcpOAuthConnect() {
  return useMutation({
    mutationFn: ({
      mcpServerId,
      options,
    }: {
      mcpServerId: string;
      options?: { redirect?: string; scopes?: string };
    }) => api.fetchMcpOAuthAuthorizeUrl(mcpServerId, options),
  });
}

export function useRefreshMcpOAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mcpServerId: string) => api.refreshMcpOAuthToken(mcpServerId),
    onSuccess: (_data, mcpServerId) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-oauth-status", mcpServerId] });
      queryClient.invalidateQueries({ queryKey: ["mcp-server", mcpServerId] });
    },
  });
}

export function useDisconnectMcpOAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mcpServerId: string) => api.disconnectMcpOAuth(mcpServerId),
    onSuccess: (_data, mcpServerId) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-oauth-status", mcpServerId] });
      queryClient.invalidateQueries({ queryKey: ["mcp-server", mcpServerId] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

export function useRegisterMcpOAuthManualClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      mcpServerId,
      data,
    }: {
      mcpServerId: string;
      data: Parameters<typeof api.registerMcpOAuthManualClient>[1];
    }) => api.registerMcpOAuthManualClient(mcpServerId, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-oauth-status", variables.mcpServerId] });
      queryClient.invalidateQueries({ queryKey: ["mcp-server", variables.mcpServerId] });
    },
  });
}
