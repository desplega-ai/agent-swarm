import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

export interface McpServerFilters {
  scope?: string;
  transport?: string;
  ownerAgentId?: string;
  enabled?: string;
  search?: string;
}

export function useMcpServers(filters?: McpServerFilters) {
  return useQuery({
    queryKey: ["mcp-servers", filters],
    queryFn: () => api.fetchMcpServers(filters),
    select: (data) => ({ servers: data.servers, total: data.total }),
  });
}

export function useMcpServer(id: string) {
  return useQuery({
    queryKey: ["mcp-server", id],
    queryFn: () => api.fetchMcpServer(id),
    enabled: !!id,
  });
}

export function useAgentMcpServers(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["agent-mcp-servers", agentId],
    queryFn: () => api.fetchAgentMcpServers(agentId),
    enabled: !!agentId && enabled,
    select: (data) => ({ servers: data.servers, total: data.total }),
  });
}

export function useCreateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
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
    }) => api.createMcpServer(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

export function useUpdateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.updateMcpServer(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-server", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["agent-mcp-servers"] });
    },
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMcpServer(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["agent-mcp-servers"] });
    },
  });
}

export function useInstallMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, agentId }: { serverId: string; agentId: string }) =>
      api.installMcpServer(serverId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["agent-mcp-servers"] });
    },
  });
}

export function useUninstallMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, agentId }: { serverId: string; agentId: string }) =>
      api.uninstallMcpServer(serverId, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["agent-mcp-servers"] });
    },
  });
}
