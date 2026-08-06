import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScriptScope } from "@/api/types";
import { api } from "../client";

export interface ScriptFilters {
  scope?: ScriptScope | "all";
  includeScratch?: boolean;
}

export function useScripts(filters?: ScriptFilters) {
  return useQuery({
    queryKey: ["scripts", filters],
    queryFn: () => api.fetchScripts(filters),
    select: (data) => data.scripts,
  });
}

export function useScript(id: string) {
  return useQuery({
    queryKey: ["script", id],
    queryFn: () => api.fetchScript(id),
    enabled: !!id,
  });
}

export function useScriptVersions(id: string) {
  return useQuery({
    queryKey: ["script-versions", id],
    queryFn: () => api.fetchScriptVersions(id),
    enabled: !!id,
  });
}

export function useUpsertScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      source: string;
      description?: string;
      intent?: string;
      agentId: string;
    }) => api.upsertScript(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scripts"] });
    },
  });
}

export function useScriptTypeDefs() {
  return useQuery({
    queryKey: ["script-type-defs"],
    queryFn: () => api.fetchScriptTypeDefs(),
    // SDK/stdlib .d.ts are DB-derived (generated connection + per-app types),
    // so refetch on remount once stale — but stay out of the QueryClient's
    // global 10s poll (providers.tsx): the blob is tens of KB and apps
    // change out-of-band.
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
}
