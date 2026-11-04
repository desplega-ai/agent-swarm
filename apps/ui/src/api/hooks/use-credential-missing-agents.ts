/**
 * Bulk credential-status hook (Phase 6 ≥1.76.0). Wraps
 * `GET /api/agents/credential-status?status=waiting_for_credentials` (the
 * bulk `credential-status` route in `src/http/agents.ts`) for Needs you on Home.
 *
 * Polled at the dashboard default (5s — TanStack global default in
 * `ui/src/app/providers.tsx`).
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { CredentialMissingAgent } from "../types";

export function useCredentialMissingAgents(options?: { enabled?: boolean }) {
  return useQuery<CredentialMissingAgent[]>({
    queryKey: ["credential-missing-agents"],
    queryFn: () => api.listCredentialMissingAgents(),
    enabled: options?.enabled ?? true,
  });
}
