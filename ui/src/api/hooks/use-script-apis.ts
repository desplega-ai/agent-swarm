import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScriptApiAuthMode } from "@/api/types";
import { api } from "../client";

export function useScriptApis(scriptId: string) {
  return useQuery({
    queryKey: ["script-apis", scriptId],
    queryFn: () => api.fetchScriptApis(scriptId),
    enabled: !!scriptId,
  });
}

export function useCreateScriptApi(scriptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { authMode: ScriptApiAuthMode; label?: string; agentId?: string }) =>
      api.createScriptApi(scriptId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["script-apis", scriptId] });
    },
  });
}

export function useUpdateScriptApi(scriptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      endpointId,
      data,
    }: {
      endpointId: string;
      data: { enabled?: boolean; label?: string | null };
    }) => api.updateScriptApi(scriptId, endpointId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["script-apis", scriptId] });
    },
  });
}

export function useRotateScriptApiSecret(scriptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (endpointId: string) => api.rotateScriptApiSecret(scriptId, endpointId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["script-apis", scriptId] });
    },
  });
}

export function useDeleteScriptApi(scriptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (endpointId: string) => api.deleteScriptApi(scriptId, endpointId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["script-apis", scriptId] });
    },
  });
}
