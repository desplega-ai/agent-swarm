/**
 * Phase 2: Shared `/status` snapshot for AppHeader (badge), AppFooter (cloud
 * affordances), HomePage, and other consumers.
 *
 * Why a context wrapping a react-query hook? `useQuery` already dedupes by
 * query key, so two `useStatus()` calls collapse into one network request —
 * BUT the polling interval option is per-call, so two callers passing
 * different intervals would race. The provider centralizes the polling
 * cadence to the value passed at mount time and exposes a single snapshot.
 */

import { createContext, type ReactNode, useContext } from "react";
import { useStatus } from "@/api/hooks";
import type { StatusResponse } from "@/api/types";

interface StatusContextValue {
  /** Latest /status payload, or null if 404 (older API), or undefined while loading. */
  data: StatusResponse | null | undefined;
  isLoading: boolean;
  error: Error | null;
}

const StatusContext = createContext<StatusContextValue | null>(null);

export interface StatusProviderProps {
  /** Polling interval in ms. `0` disables polling entirely. Default: 30_000. */
  pollIntervalMs?: number;
  children: ReactNode;
}

export function StatusProvider({ pollIntervalMs = 30_000, children }: StatusProviderProps) {
  const { data, isLoading, error } = useStatus({ pollIntervalMs });
  const value: StatusContextValue = {
    data,
    isLoading,
    error: error instanceof Error ? error : error ? new Error(String(error)) : null,
  };
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

/**
 * Read the shared status snapshot. Returns the same shape as `useStatus()`.
 * Throws if used outside a `<StatusProvider>`.
 */
export function useStatusContext(): StatusContextValue {
  const ctx = useContext(StatusContext);
  if (!ctx) {
    throw new Error("useStatusContext must be used within a <StatusProvider>");
  }
  return ctx;
}
