/**
 * Improvements: product comments for desplega. The browser only talks to the
 * agent-swarm API; the server sends to the proxy after a person approves.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { SubmitImprovementInput } from "../types";

const KEY = ["improvements"] as const;

export function useImprovements(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.fetchImprovements(),
    enabled: options?.enabled ?? true,
  });
}

function useImprovementMutation<T>(fn: (input: T) => ReturnType<typeof api.submitImprovement>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSubmitImprovement() {
  return useImprovementMutation((input: SubmitImprovementInput) => api.submitImprovement(input));
}

export function useApproveImprovement() {
  return useImprovementMutation((input: { id: string; email: string | null }) =>
    api.approveImprovement(input.id, input.email),
  );
}

export function useDiscardImprovement() {
  return useImprovementMutation((id: string) => api.discardImprovement(id));
}
