/**
 * Bulk credential-status hook (Phase 6 ≥1.76.0). Wraps
 * `GET /api/agents/credential-status?status=waiting_for_credentials` (the
 * bulk `credential-status` route in `src/http/agents.ts`) for Needs you on Home.
 *
 * Polled at the dashboard default (10s, the TanStack global default in
 * `ui/src/app/providers.tsx`) unless `refetchInterval` replaces it.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { CredentialMissingAgent } from "../types";

export function useCredentialMissingAgents(options?: {
  enabled?: boolean;
  refetchInterval?: number;
}) {
  return useQuery<CredentialMissingAgent[]>({
    queryKey: ["credential-missing-agents"],
    queryFn: () => api.listCredentialMissingAgents(),
    enabled: options?.enabled ?? true,
    // An explicit `undefined` would turn the app-wide poll off.
    ...(options?.refetchInterval !== undefined && { refetchInterval: options.refetchInterval }),
  });
}
