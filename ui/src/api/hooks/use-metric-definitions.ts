import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { MetricParam, MetricSaveInput } from "../types";

export interface MetricDefinitionsFilters {
  agentId?: string;
  limit?: number;
  offset?: number;
  fields?: "full" | "slim";
}

export function useMetricDefinitions(filters?: MetricDefinitionsFilters) {
  return useQuery({
    queryKey: ["metric-definitions", filters],
    queryFn: () => api.listMetrics(filters),
    refetchInterval: 30_000,
  });
}

export function useMetricDefinition(id: string | undefined) {
  return useQuery({
    queryKey: ["metric-definition", id],
    queryFn: () => api.getMetric(id ?? ""),
    enabled: !!id,
  });
}

export function useMetricRun(
  id: string | undefined,
  refreshSeconds?: number,
  variables?: Record<string, MetricParam>,
) {
  return useQuery({
    queryKey: ["metric-run", id, variables],
    queryFn: () => api.runMetric(id ?? "", variables),
    enabled: !!id,
    refetchInterval: refreshSeconds ? refreshSeconds * 1000 : false,
  });
}

export function useCreateMetric() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MetricSaveInput) => api.createMetric(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["metric-definitions"] });
    },
  });
}

export function useUpdateMetric() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<MetricSaveInput> }) =>
      api.updateMetric(id, input),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["metric-definitions"] });
      queryClient.invalidateQueries({ queryKey: ["metric-definition", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["metric-run", variables.id] });
    },
  });
}
