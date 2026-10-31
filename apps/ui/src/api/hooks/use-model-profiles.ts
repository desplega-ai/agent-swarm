import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

/**
 * Model profiles from `GET /api/model-profiles`, optionally for one harness
 * (what an agent on that harness can run). A model profile is a named harness,
 * model and effort; not the agent's role profile.
 */
export function useModelProfiles({ harness }: { harness?: string } = {}) {
  return useQuery({
    queryKey: ["model-profiles", "list", harness ?? null],
    queryFn: async () => (await api.fetchModelProfiles(harness)).profiles,
    staleTime: 30 * 1000,
  });
}

/**
 * `GET /api/agents/{id}/profile-check` for one profile, judged against the
 * agent's saved harness and its latest credential report. Idle without a
 * profile.
 */
export function useModelProfileCheck(agentId: string, profile: string | null | undefined) {
  return useQuery({
    queryKey: ["model-profiles", "check", agentId, profile ?? null],
    queryFn: () => api.fetchModelProfileCheck(agentId, profile as string),
    enabled: Boolean(profile),
    staleTime: 5 * 1000,
  });
}
