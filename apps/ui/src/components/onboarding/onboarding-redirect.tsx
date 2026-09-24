import { useState } from "react";
import { Navigate } from "react-router-dom";
import { isOnboardingOpen, useOnboarding } from "@/api/hooks/use-onboarding";
import { useConfig } from "@/hooks/use-config";

// API URLs whose `/setup` was opened during this page load. The redirect is a
// landing rule: once the operator has seen setup for a connection, in-app
// links out of it (a step's Settings link, step 6 opening the new session)
// must not bounce back to it. The header pill and the home card lead back
// instead. Keyed per connection, so another swarm with open onboarding still
// redirects.
const setupVisited = new Set<string>();

export function markSetupVisited(apiUrl: string) {
  setupVisited.add(apiUrl);
}

/**
 * Mounted in the configured app shell. Sends the operator to `/setup` while
 * onboarding is open and not minimized. It is also the one poller of the
 * onboarding query in the shell, so the pill and the home card stay current.
 */
export function OnboardingRedirect() {
  const { config, pendingConnection } = useConfig();
  const { data, dataUpdatedAt, isFetchedAfterMount } = useOnboarding({
    // No polling once onboarding is finished, dismissed, or absent.
    refetchInterval: (query) => (isOnboardingOpen(query.state.data) ? 30_000 : false),
  });
  const [mountedAt] = useState(Date.now);

  if (setupVisited.has(config.apiUrl) || pendingConnection || !data) return null;
  // Decide on a payload fetched after this mount, never on the persisted
  // cache: hydration can count as "fetched after mount" without a request,
  // so the timestamp check backs up `isFetchedAfterMount`.
  if (!isFetchedAfterMount || dataUpdatedAt < mountedAt) return null;
  if (!isOnboardingOpen(data) || data.state.minimizedAt) return null;
  return <Navigate to="/setup" replace />;
}
