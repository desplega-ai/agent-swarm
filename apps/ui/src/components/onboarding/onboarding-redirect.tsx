import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { isOnboardingOpen, ONBOARDING_QUERY_KEY, useOnboarding } from "@/api/hooks/use-onboarding";
import type { OnboardingResponse } from "@/api/types";
import { useConfig } from "@/hooks/use-config";

// Set by `/setup` on mount. The redirect is a landing rule: once the operator
// has seen setup during this page load, in-app links out of it (a step's
// Settings link, step 6 opening the new session) must not bounce back to it.
// The header pill and the home card lead back instead.
let setupVisited = false;

export function markSetupVisited() {
  setupVisited = true;
}

/**
 * Mounted in the configured app shell. Sends the operator to `/setup` while
 * onboarding is open and not minimized. It is also the one poller of the
 * onboarding query in the shell, so the pill and the home card stay current.
 */
export function OnboardingRedirect() {
  const { pendingConnection } = useConfig();
  const cached = useQueryClient().getQueryData<OnboardingResponse | null>(ONBOARDING_QUERY_KEY);
  const { data, dataUpdatedAt, isFetchedAfterMount } = useOnboarding({
    // No polling once onboarding is finished, dismissed, or absent.
    pollIntervalMs: isOnboardingOpen(cached) ? 30_000 : 0,
  });
  const [mountedAt] = useState(Date.now);

  if (setupVisited || pendingConnection || !data) return null;
  // Decide on a payload fetched after this mount, never on the persisted
  // cache: hydration can count as "fetched after mount" without a request,
  // so the timestamp check backs up `isFetchedAfterMount`.
  if (!isFetchedAfterMount || dataUpdatedAt < mountedAt) return null;
  if (!isOnboardingOpen(data) || data.state.minimizedAt) return null;
  return <Navigate to="/setup" replace />;
}
