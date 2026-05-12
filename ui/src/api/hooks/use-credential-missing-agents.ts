/**
 * Bulk credential-status hook (Phase 6 ≥1.76.0). Wraps
 * `GET /api/agents/credential-status?status=waiting_for_credentials` (handler
 * at `src/http/agents.ts:462-480`) for the Blocking inbox bucket.
 *
 * Polled at the dashboard default (5s — TanStack global default in
 * `ui/src/app/providers.tsx`).
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../client";
import type { CredentialMissingAgent } from "../types";

export function useCredentialMissingAgents() {
  return useQuery<CredentialMissingAgent[]>({
    queryKey: ["credential-missing-agents"],
    queryFn: () => api.listCredentialMissingAgents(),
  });
}
