/**
 * Org profile actions beyond plain config writes: the "used by" consent and
 * turning telemetry on at runtime. Both go through dedicated API routes so the
 * server can reach the telemetry proxy and re-initialize telemetry.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
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
