/**
 * Sessions surface (Phase 4 ≥1.76.0) — react-query bindings for the
 * `/api/sessions` endpoints.
 *
 * - `useSessions()` powers the `/sessions` sidebar list (root-task chains
 *   ordered by chain-wide last activity). Filter (`source`) and search
 *   (`q`) are pushed up to the API — the UI never filters in memory.
 * - `useSession(rootTaskId)` returns the full chain payload for the
 *   selected session.
 *
 * Soft-degrade: callers must wrap usage in `useFeatureGate("1.76.0")` so
 * older API servers (which 404 these endpoints) don't render the surface.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

export interface UseSessionsOptions {
  limit?: number;
  offset?: number;
  /** Source filter (e.g. `["ui"]`). Empty / undefined → all sources. */
  source?: string[];
  /** Case-insensitive substring search against the root task's text. */
  q?: string;
}

export function useSessions(options?: UseSessionsOptions) {
  const limit = options?.limit ?? 50;
  const offset = options?.offset;
  const source = options?.source;
  const q = options?.q;
  return useQuery({
    queryKey: ["sessions", { limit, offset, source, q }],
    queryFn: () => api.listSessions({ limit, offset, source, q }),
  });
}

export function useSession(rootTaskId: string | undefined) {
  return useQuery({
    queryKey: ["session", rootTaskId],
    queryFn: () => api.getSession(rootTaskId!),
    enabled: !!rootTaskId,
  });
}
