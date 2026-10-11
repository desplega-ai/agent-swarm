import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Agent,
  RuntimeControllerInput,
  RuntimePoolCreateAgentInput,
  RuntimePoolInput,
} from "@/api/types";
import { api, RuntimePoolApiError } from "../client";

/** Runtimes poll cadence while a pool detail page is open (no realtime channel in v1). */
const RUNTIMES_REFETCH_MS = 5_000;

export function useRuntimePools(enabled = true) {
  return useQuery({
    queryKey: ["runtime-pools"],
    queryFn: () => api.fetchRuntimePools(),
    enabled,
  });
}

export function useRuntimePool(id: string | undefined) {
  return useQuery({
    queryKey: ["runtime-pool", id],
    queryFn: () => api.fetchRuntimePool(id as string),
    enabled: !!id,
    // A missing pool stays missing: show "not found" at once instead of retrying.
    retry: (failures, error) =>
      !(error instanceof RuntimePoolApiError && error.status === 404) && failures < 3,
  });
}

export function useRuntimePoolRuntimes(id: string | undefined) {
  return useQuery({
    queryKey: ["runtime-pool-runtimes", id],
    queryFn: () => api.fetchRuntimePoolRuntimes(id as string),
    enabled: !!id,
    refetchInterval: RUNTIMES_REFETCH_MS,
  });
}

export function useRuntimeControllers(enabled = true) {
  return useQuery({
    queryKey: ["runtime-controllers"],
    queryFn: () => api.fetchRuntimeControllers(),
    enabled,
  });
}

export function useRuntimeController(id: string | undefined) {
  return useQuery({
    queryKey: ["runtime-controller", id],
    queryFn: () => api.fetchRuntimeController(id as string),
    enabled: !!id,
  });
}

/**
 * Invalidate every query that reads a pool, a controller, or a binding after a
 * write. Agents carry `runtimePoolId`, so agent queries refresh too.
 */
function useRuntimePoolInvalidator() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["runtime-pools"] });
    void queryClient.invalidateQueries({ queryKey: ["runtime-pool"] });
    void queryClient.invalidateQueries({ queryKey: ["runtime-pool-runtimes"] });
    void queryClient.invalidateQueries({ queryKey: ["runtime-controllers"] });
    void queryClient.invalidateQueries({ queryKey: ["runtime-controller"] });
    void queryClient.invalidateQueries({ queryKey: ["agents"] });
    void queryClient.invalidateQueries({ queryKey: ["agent"] });
  };
}

export function useCreateRuntimePool() {
  const invalidate = useRuntimePoolInvalidator();
  return useMutation({
    mutationFn: (input: RuntimePoolInput) => api.createRuntimePool(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateRuntimePool(id: string) {
  const invalidate = useRuntimePoolInvalidator();
  return useMutation({
    mutationFn: (input: Partial<RuntimePoolInput>) => api.updateRuntimePool(id, input),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteRuntimePool(id: string) {
  const invalidate = useRuntimePoolInvalidator();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (force: boolean) => api.deleteRuntimePool(id, force),
    onSuccess: () => {
      // The pool is gone; drop its per-id caches instead of refetching a 404.
      queryClient.removeQueries({ queryKey: ["runtime-pool", id] });
      queryClient.removeQueries({ queryKey: ["runtime-pool-runtimes", id] });
      invalidate();
    },
  });
}

export function useCreateRuntimePoolAgent(poolId: string) {
  const invalidate = useRuntimePoolInvalidator();
  return useMutation({
    mutationFn: (input: RuntimePoolCreateAgentInput) => api.createRuntimePoolAgent(poolId, input),
    onSuccess: () => invalidate(),
  });
}

/**
 * The agent page polls `["agent", id]`. A GET that started before the PUT
 * would answer with the old pool and snap the select back, so cancel it first
 * and write the PUT response into the cache (dashboard-ui rule).
 */
export function useBindAgentRuntimePool() {
  const invalidate = useRuntimePoolInvalidator();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, poolId }: { agentId: string; poolId: string | null }) =>
      api.bindAgentRuntimePool(agentId, poolId),
    onMutate: async ({ agentId }) => {
      await queryClient.cancelQueries({ queryKey: ["agent", agentId] });
    },
    onSuccess: (agent) => {
      queryClient.setQueryData<Agent>(["agent", agent.id], (old) =>
        old ? { ...old, runtimePoolId: agent.runtimePoolId ?? null } : old,
      );
      invalidate();
    },
  });
}

export function useCreateRuntimeController() {
  const invalidate = useRuntimePoolInvalidator();
  return useMutation({
    mutationFn: (input: RuntimeControllerInput) => api.createRuntimeController(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateRuntimeController() {
  const invalidate = useRuntimePoolInvalidator();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RuntimeControllerInput }) =>
      api.updateRuntimeController(id, input),
    onSuccess: () => invalidate(),
  });
}

/**
 * Mint a remote controller token (revokes the previous one). `gcTime: 0` drops
 * the finished mutation from the cache at once, so the plaintext lives only in
 * the dialog that shows it.
 */
export function useMintRuntimeControllerToken() {
  const invalidate = useRuntimePoolInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.mintRuntimeControllerToken(id),
    gcTime: 0,
    // The old session disconnects, so the controller status can change.
    onSuccess: () => invalidate(),
  });
}

export function useDeleteRuntimeController() {
  const invalidate = useRuntimePoolInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.deleteRuntimeController(id),
    onSuccess: () => invalidate(),
  });
}
