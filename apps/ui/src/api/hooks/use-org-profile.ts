/**
 * Org profile actions beyond plain config writes: the "used by" consent and
 * turning telemetry on at runtime. Both go through dedicated API routes so the
 * server can reach the telemetry proxy and re-initialize telemetry.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RankingForm } from "../client";
import type { TelemetryEnableVia, UsedByConsentInput } from "../types";

export function useSetUsedByConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UsedByConsentInput) => api.setUsedByConsent(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
    },
  });
}

export function useEnableTelemetry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (via: TelemetryEnableVia) => api.enableTelemetry(via),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["configs"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

/** `identityKey` changes when the org name or website is saved, which refetches. */
export function useRanking(identityKey: string) {
  return useQuery({ queryKey: ["ranking", identityKey], queryFn: () => api.getRanking() });
}

export function useRankingOptIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (form: RankingForm) => api.rankingOptIn(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ranking"] });
      queryClient.invalidateQueries({ queryKey: ["configs"] });
    },
  });
}

export function useRankingOptOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.rankingOptOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ranking"] });
      queryClient.invalidateQueries({ queryKey: ["configs"] });
    },
  });
}
