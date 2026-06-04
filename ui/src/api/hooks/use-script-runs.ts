import { useQuery } from "@tanstack/react-query";
import type { ScriptRunStatus } from "@/api/types";
import { api } from "../client";

export function useScriptRuns(filters?: {
  status?: ScriptRunStatus | "all";
  agentId?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ["script-runs", filters],
    queryFn: () => api.fetchScriptRuns(filters),
  });
}

export function useScriptRun(id: string) {
  return useQuery({
    queryKey: ["script-run", id],
    queryFn: () => api.fetchScriptRun(id),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === "running" || status === "paused" ? 3000 : false;
    },
  });
}
