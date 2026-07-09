/**
 * Unified Home — the `/` landing page. This is the only home surface; there is
 * no `/old-home` or `/old-dashboard`. To change what `/` shows, change this file.
 *
 * A welcome heading above the full swarm `AgentActivityTimeline`. The timeline
 * fetches its own data and owns its loading/error/empty states, and fills the
 * height it is given, so this page contributes only the header and padding.
 *
 * The `flex-1 min-h-0` chain from the root down to the timeline slot is
 * load-bearing: break it and the timeline's `h-full` resolves against an auto
 * height and collapses.
 *
 * The timeline is feature-gated on API ≥1.76.0. The gate is evaluated against
 * the *resolved* version: while the version query is pending we render a
 * skeleton, never the "requires 1.76+" notice — that only shows on a confirmed
 * unsupported version.
 */

import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { AgentActivityTimeline } from "@/components/dashboard/agent-activity-timeline";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/contexts/current-user-context";

export function UnifiedHome() {
  const { user } = useCurrentUser();
  const { supported, currentVersion } = useFeatureGate("1.76.0");

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
        <TimelineRegion versionResolved={versionResolved} supported={supported} />
      </div>
    </div>
  );
}

function TimelineRegion({
  versionResolved,
  supported,
}: {
  versionResolved: boolean;
  supported: boolean;
}) {
  // Version query still in flight — placeholder, no premature notice.
  if (!versionResolved) {
    return <Skeleton className="h-full w-full rounded-lg" />;
  }

  // Confirmed older API server — the timeline surface isn't available.
  if (!supported) {
    return (
      <AlertCallout tone="info">Agent activity view requires Agent Swarm API 1.76+.</AlertCallout>
    );
  }

  return <AgentActivityTimeline />;
}

export default UnifiedHome;
