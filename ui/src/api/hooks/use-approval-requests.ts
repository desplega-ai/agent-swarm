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
      respondedBy,
    }: {
      id: string;
      responses: Record<string, unknown>;
      respondedBy?: string;
    }) => api.respondToApprovalRequest(id, responses, respondedBy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approval-requests"] });
      queryClient.invalidateQueries({ queryKey: ["approval-request"] });
    },
  });
}
