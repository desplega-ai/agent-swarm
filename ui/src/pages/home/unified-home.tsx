/**
 * Unified Home — `/` (Plan Phase 2).
 *
 * A minimal landing page: a welcome heading above a full-bleed `AgentCanvas`.
 * Replaces the old `/status`-driven Home (preserved at `/old-home`) and the
 * Canvas/Table dashboard (preserved at `/old-dashboard`).
 *
 * Layout chain is load-bearing: the root is `flex flex-col flex-1 min-h-0`,
 * the welcome header is `shrink-0`, and the canvas region is `flex-1 min-h-0`.
 * `AgentCanvas`'s `fullBleed` variant is `h-full`, and ReactFlow needs a
 * definite-height parent — break the `min-h-0` chain and the canvas collapses
 * to 0px.
 *
 * The canvas is feature-gated on API ≥1.76.0 (the implicit shield it had via
 * `NewDashboard`). The gate is evaluated against the *resolved* version: while
 * the version query is pending we render a skeleton, never the "requires 1.76+"
 * notice — that only shows on a confirmed-unsupported version.
 */

import { useAgentActivity } from "@/api/hooks/use-agent-activity";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { AgentCanvas } from "@/components/dashboard/agent-canvas";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/contexts/current-user-context";

export function UnifiedHome() {
  const { user } = useCurrentUser();
  const { supported, currentVersion } = useFeatureGate("1.76.0");
  const activity = useAgentActivity({ windowHours: 24 });

  const welcome = user?.name ? `Welcome back, ${user.name}` : "Welcome to Agent Swarm";

  // Gate on the *resolved* version: `supported` is `false` while the version
  // query is pending, so distinguish "still resolving" from "confirmed too old".
  const versionResolved = currentVersion !== null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 px-4 pt-4 md:px-6 md:pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">{welcome}</h1>
      </div>
      <div className="flex-1 min-h-0 px-4 pb-4 pt-4 md:px-6 md:pb-6">
        <CanvasRegion versionResolved={versionResolved} supported={supported} activity={activity} />
      </div>
    </div>
  );
}

function CanvasRegion({
  versionResolved,
  supported,
  activity,
}: {
  versionResolved: boolean;
  supported: boolean;
  activity: ReturnType<typeof useAgentActivity>;
}) {
  // Version query still in flight — placeholder, no premature notice.
  if (!versionResolved) {
    return <Skeleton className="h-full w-full rounded-lg" />;
  }

  // Confirmed older API server — the canvas surface isn't available.
  if (!supported) {
    return (
      <AlertCallout tone="info">Agent activity view requires Agent Swarm API 1.76+.</AlertCallout>
    );
  }

  if (activity.isLoading) {
    return <Skeleton className="h-full w-full rounded-lg" />;
  }

  if (activity.isError) {
    return (
      <AlertCallout tone="error">
        Couldn't load agent activity. Check the API connection and try again.
      </AlertCallout>
    );
  }

  return <AgentCanvas rows={activity.agents} fullBleed />;
}

export default UnifiedHome;
