import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";

export interface ApprovalRequestFilters {
  status?: string;
  workflowRunId?: string;
  limit?: number;
}

export function useApprovalRequests(filters?: ApprovalRequestFilters) {
  return useQuery({
    queryKey: ["approval-requests", filters],
    queryFn: () => api.fetchApprovalRequests(filters),
    select: (data) => data.approvalRequests,
    refetchInterval: 5000,
  });
}

/** The approvals list page's slim rows; shares the `approval-requests` key prefix for invalidation. */
export function useApprovalRequestSummaries(filters?: { status?: string; limit?: number }) {
  return useQuery({
    queryKey: ["approval-requests", "slim", filters],
    queryFn: () => api.fetchApprovalRequestSummaries(filters),
    select: (data) => data.approvalRequests,
    refetchInterval: 5000,
  });
}

export function useApprovalRequest(id: string) {
  return useQuery({
    queryKey: ["approval-request", id],
    queryFn: () => api.fetchApprovalRequest(id),
    select: (data) => data.approvalRequest,
    enabled: !!id,
    refetchInterval: 5000,
  });
}

export function useRespondToApprovalRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      responses,
      claimedRespondedBy,
    }: {
      id: string;
      responses: Record<string, unknown>;
      /** Unverified display name; the server records the credential's identity. */
      claimedRespondedBy?: string;
    }) => api.respondToApprovalRequest(id, responses, claimedRespondedBy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approval-requests"] });
      queryClient.invalidateQueries({ queryKey: ["approval-request"] });
    },
  });
}

export function useCancelApprovalRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.cancelApprovalRequest(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approval-requests"] });
      queryClient.invalidateQueries({ queryKey: ["approval-request"] });
    },
  });
}
