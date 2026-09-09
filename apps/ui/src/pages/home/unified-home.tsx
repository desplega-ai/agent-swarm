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

import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { AgentActivityTimeline } from "@/components/dashboard/agent-activity-timeline";
import { DashboardNudges } from "@/components/dashboard/dashboard-nudges";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Skeleton } from "@/components/ui/skeleton";

export function UnifiedHome() {
  const { supported, currentVersion, isError, error } = useFeatureGate("1.76.0");

  // The greeting lives in the top bar's breadcrumb slot now (Breadcrumbs
  // renders it on `/`) — this page is just the timeline region.

  // Gate on the *resolved* version: `supported` is `false` while the version
  // query is pending, so distinguish "still resolving" from "confirmed too old".
  const versionResolved = currentVersion !== null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-1 min-h-0 flex-col gap-4 px-4 pb-4 pt-4 md:px-6 md:pb-6">
        <DashboardNudges />
        <div className="flex-1 min-h-0">
          <TimelineRegion
            versionResolved={versionResolved}
            supported={supported}
            isError={isError}
            error={error}
          />
        </div>
      </div>
    </div>
  );
}

function TimelineRegion({
  versionResolved,
  supported,
  isError,
  error,
}: {
  versionResolved: boolean;
  supported: boolean;
  isError: boolean;
  error: Error | null;
}) {
  // The version probe failed outright (dead apiUrl, bad key, CORS, network) —
  // stop spinning a skeleton forever and tell the user why, with a way out.
  if (!versionResolved && isError) {
    return (
      <AlertCallout tone="error" icon={AlertTriangle} title="Can't reach the API server">
        {error?.message ? `${error.message}.` : "The health check failed."} Check your connection
        under{" "}
        <Link to="/settings/connections" className="underline underline-offset-2">
          Settings → Connections
        </Link>
        .
      </AlertCallout>
    );
  }

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
