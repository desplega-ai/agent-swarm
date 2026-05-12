import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import type { BudgetScope, PricingProvider, PricingTokenClass } from "../types";

const POLL_INTERVAL = 5000;

export function useBudgets() {
  return useQuery({
    queryKey: ["budgets"],
    queryFn: () => api.fetchBudgets(),
    select: (data) => data.budgets,
    refetchInterval: POLL_INTERVAL,
  });
}

export function useBudgetRefusals(limit = 50) {
  return useQuery({
    queryKey: ["budget-refusals", limit],
    queryFn: () => api.fetchBudgetRefusals(limit),
    select: (data) => data.refusals,
    refetchInterval: POLL_INTERVAL,
  });
}

export function useUpsertBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      scope,
      scopeId,
      dailyBudgetUsd,
    }: {
      scope: BudgetScope;
      scopeId: string;
      dailyBudgetUsd: number;
    }) => api.upsertBudget(scope, scopeId, dailyBudgetUsd),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
      queryClient.invalidateQueries({ queryKey: ["logs"] });
    },
  });
}

export function useDeleteBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ scope, scopeId }: { scope: BudgetScope; scopeId: string }) =>
      api.deleteBudget(scope, scopeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
      queryClient.invalidateQueries({ queryKey: ["logs"] });
    },
  });
}

export function usePricing() {
  return useQuery({
    queryKey: ["pricing"],
    queryFn: () => api.fetchPricing(),
    select: (data) => data.rows,
  });
}

export function useInsertPricing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      provider: PricingProvider;
      model: string;
      tokenClass: PricingTokenClass;
      pricePerMillionUsd: number;
      effectiveFrom?: number;
    }) => api.insertPricingRow(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing"] });
      queryClient.invalidateQueries({ queryKey: ["logs"] });
    },
  });
}

export function useDeletePricing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      model,
      tokenClass,
      effectiveFrom,
    }: {
      provider: PricingProvider;
      model: string;
      tokenClass: PricingTokenClass;
      effectiveFrom: number;
    }) => api.deletePricingRow(provider, model, tokenClass, effectiveFrom),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pricing"] });
      queryClient.invalidateQueries({ queryKey: ["logs"] });
    },
  });
}
