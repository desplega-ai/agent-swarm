/**
 * The admin "All users" read scope (`lib/all-users-scope.ts`): whether the
 * picked identity may use it, and the tab's opt-in.
 *
 * `available` needs an API that honors the scope and a whoami that says this
 * identity may read every session. On the operator key whoami answers for the
 * user picked in `X-Swarm-User-Id`, so the query key carries that user.
 * Turning the scope on or off, here or in another tab, resets every tab's
 * cached queries (`bindAllUsersScopeCache` in the app providers): lists,
 * counts, and open pages all change with it.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useConfig } from "@/hooks/use-config";
import {
  ALL_USERS_SCOPE_MIN_VERSION,
  allUsersScopeIdentity,
  setAllUsersScope,
  useStoredAllUsersScope,
} from "@/lib/all-users-scope";
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
  const { supported } = useFeatureGate(ALL_USERS_SCOPE_MIN_VERSION);
  const whoami = useQuery({
    // Keyed by the full identity: two tokens can share their last characters.
    queryKey: ["whoami", "session-read-all", config.apiUrl, allUsersScopeIdentity(config)],
    queryFn: () => api.whoami(),
    enabled: supported,
    // A role change shows up on focus, at most once a minute.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const stored = useStoredAllUsersScope(config);
  const available = supported && whoami.data?.sessionReadAll === true;
  const setEnabled = useCallback((on: boolean) => setAllUsersScope(config, on), [config]);
  return { available, enabled: available && stored, setEnabled };
}
