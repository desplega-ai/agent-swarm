import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { AgentWithTasks } from "../types";

export function useAgents(includeTasks = false) {
  return useQuery({
    queryKey: ["agents", includeTasks],
    queryFn: () => api.fetchAgents(includeTasks),
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
      profile: {
        role?: string;
        description?: string;
        capabilities?: string[];
        claudeMd?: string;
        soulMd?: string;
        identityMd?: string;
      };
    }) => api.updateAgentProfile(id, profile),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["agent"] });
    },
  });
}
