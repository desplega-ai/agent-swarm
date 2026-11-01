/**
 * The admin "All users" read scope (`lib/all-users-scope.ts`): whether the
 * picked identity may use it, and the tab's opt-in.
 *
 * `available` needs an API that honors the scope and a whoami that says this
 * identity may read every session. On the operator key whoami answers for the
 * user picked in `X-Swarm-User-Id`, so the query key carries that user.
 * Turning the scope on or off refetches every query: lists, counts, and open
 * pages all change with it.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useConfig } from "@/hooks/use-config";
import {
  ALL_USERS_SCOPE_MIN_VERSION,
  setAllUsersScope,
  useStoredAllUsersScope,
} from "@/lib/all-users-scope";
import { dashboardUserIdFor } from "@/lib/dashboard-user";
import { api } from "../client";
import { useFeatureGate } from "./use-feature-gate";

export interface AllUsersScope {
  /** The identity may use the scope, on an API that honors it. */
  available: boolean;
  /** The scope is on (always false while unavailable). */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
}

export function useAllUsersScope(): AllUsersScope {
  const { config } = useConfig();
  const queryClient = useQueryClient();
  const { supported } = useFeatureGate(ALL_USERS_SCOPE_MIN_VERSION);
  const pickedUserId = dashboardUserIdFor(config);
  const whoami = useQuery({
    queryKey: ["whoami", "session-read-all", config.apiUrl, config.apiKey.slice(-4), pickedUserId],
    queryFn: () => api.whoami(),
    enabled: supported,
    // A role change shows up on focus, at most once a minute.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const stored = useStoredAllUsersScope(config);
  const available = supported && whoami.data?.sessionReadAll === true;
  const setEnabled = useCallback(
    (on: boolean) => {
      setAllUsersScope(config, on);
      void queryClient.invalidateQueries();
    },
    [config, queryClient],
  );
  return { available, enabled: available && stored, setEnabled };
}
