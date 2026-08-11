import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useCurrentUser } from "@/contexts/current-user-context";
import { api } from "../client";
import type {
  DevFlowAgentMode,
  DevFlowScopeInput,
  DevFlowSpecInput,
  DevFlowState,
  DevFlowWorkItemType,
} from "../devflow-types";

function useDevFlowUserId(): string {
  return useCurrentUser().userId ?? "";
}

export function useDevFlowOrganization() {
  const userId = useDevFlowUserId();
  return useQuery({
    queryKey: ["devflow", "organization", userId],
    queryFn: () => api.fetchDevFlowOrganization(userId),
    enabled: !!userId,
    staleTime: 60_000,
  });
}

export function useDevFlowWorkItems(filters?: {
  state?: DevFlowState;
  type?: DevFlowWorkItemType;
  search?: string;
}) {
  const userId = useDevFlowUserId();
  return useQuery({
    queryKey: ["devflow", "work-items", userId, filters],
    queryFn: () => api.fetchDevFlowWorkItems(userId, filters),
    enabled: !!userId,
    refetchInterval: 5_000,
  });
}

export function useDevFlowWorkItem(id: string) {
  const userId = useDevFlowUserId();
  return useQuery({
    queryKey: ["devflow", "work-item", userId, id],
    queryFn: () => api.fetchDevFlowWorkItem(userId, id),
    enabled: !!userId && !!id,
    refetchInterval: 5_000,
  });
}

function useInvalidateDevFlow(id?: string) {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ["devflow", "work-items"] });
    if (id) await queryClient.invalidateQueries({ queryKey: ["devflow", "work-item"] });
  };
}

export function useCreateDevFlowWorkItem() {
  const userId = useDevFlowUserId();
  const invalidate = useInvalidateDevFlow();
  return useMutation({
    mutationFn: (input: { title: string; description: string; type?: DevFlowWorkItemType }) =>
      api.createDevFlowWorkItem(userId, input),
    onSuccess: async () => {
      await invalidate();
      toast.success("Idea captured");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useUpdateDevFlowWorkItem(id: string) {
  const userId = useDevFlowUserId();
  const invalidate = useInvalidateDevFlow(id);
  return useMutation({
    mutationFn: (input: Parameters<typeof api.updateDevFlowWorkItem>[2]) =>
      api.updateDevFlowWorkItem(userId, id, input),
    onSuccess: async () => {
      await invalidate();
      toast.success("Work item saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useTransitionDevFlowWorkItem(id: string) {
  const userId = useDevFlowUserId();
  const invalidate = useInvalidateDevFlow(id);
  return useMutation({
    mutationFn: (input: {
      toState: DevFlowState;
      rationale: string;
      blockerReason?: string;
      archiveReason?: string;
    }) => api.transitionDevFlowWorkItem(userId, id, input),
    onSuccess: async () => {
      await invalidate();
      toast.success("Lifecycle updated");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useSaveDevFlowScope(id: string) {
  const userId = useDevFlowUserId();
  const invalidate = useInvalidateDevFlow(id);
  return useMutation({
    mutationFn: (input: DevFlowScopeInput) => api.saveDevFlowScope(userId, id, input),
    onSuccess: async () => {
      await invalidate();
      toast.success("Scope draft saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useSaveDevFlowSpec(id: string) {
  const userId = useDevFlowUserId();
  const invalidate = useInvalidateDevFlow(id);
  return useMutation({
    mutationFn: (input: DevFlowSpecInput) => api.saveDevFlowSpec(userId, id, input),
    onSuccess: async () => {
      await invalidate();
      toast.success("Spec version saved");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useStartDevFlowAgentRun(id: string) {
  const userId = useDevFlowUserId();
  const invalidate = useInvalidateDevFlow(id);
  return useMutation({
    mutationFn: (mode: DevFlowAgentMode) => api.startDevFlowAgentRun(userId, id, mode),
    onSuccess: async () => {
      await invalidate();
      toast.success("Agent Swarm run queued");
    },
    onError: (error) => toast.error(error.message),
  });
}

export function useReconcileDevFlowAgentRun(id: string) {
  const userId = useDevFlowUserId();
  const invalidate = useInvalidateDevFlow(id);
  return useMutation({
    mutationFn: (runId: string) => api.reconcileDevFlowAgentRun(userId, runId),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
}
