/**
 * Unified Home: the `/` landing page and the command center. This is the only
 * home surface; there is no `/old-home` or `/old-dashboard`. To change what
 * `/` shows, change this file.
 *
 * The admin nudge banner on top, then a widget grid: from `xl` two equal
 * columns with aligned tops (left: Needs you, In progress; right: the
 * checklist, Favorites). Below `xl` one column in the order Needs you,
 * checklist, In progress, Favorites. The swarm activity timeline is a full
 * width widget under the grid. Phones get the same widgets.
 *
 * The page owns its scroll: from `lg` the layout's `main` does not scroll.
 *
 * The timeline is feature-gated on API ≥1.76.0. The gate is evaluated against
 * the *resolved* version: while the version query is pending we render a
 * skeleton, never the "requires 1.76+" notice. That only shows on a confirmed
 * unsupported version.
 */

import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { PostOnboardingChecklistCard } from "@/components/checklist/post-onboarding-checklist-card";
import { AgentActivityTimeline } from "@/components/dashboard/agent-activity-timeline";
import { DashboardNudges } from "@/components/dashboard/dashboard-nudges";
import { Favorites } from "@/components/home/favorites";
import { InProgress } from "@/components/home/in-progress";
import { NeedsYou } from "@/components/home/needs-you";
import { SetupChecklistCard } from "@/components/onboarding/setup-checklist-card";
import { LocalNetworkHelp } from "@/components/shared/local-network-help";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfig } from "@/hooks/use-config";

/**
 * A column of the grid from `xl`. Below `xl` it is `display: contents`, so
 * its widgets join the single column and `order-*` interleaves the two
 * columns (Needs you, checklist, In progress, Favorites).
 */
const COLUMN = "contents xl:flex xl:min-w-0 xl:flex-col xl:gap-4";

export function UnifiedHome() {
  const { supported, currentVersion, isError, error } = useFeatureGate("1.76.0");
  const { config, pendingConnection } = useConfig();

  // The greeting lives in the top bar's breadcrumb slot (Breadcrumbs renders
  // it on `/`).

  // Gate on the *resolved* version: `supported` is `false` while the version
  // query is pending, so distinguish "still resolving" from "confirmed too old".
  const versionResolved = currentVersion !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 px-4 pb-4 pt-4 md:px-6 md:pb-6">
        <DashboardNudges />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:items-start">
          <div className={COLUMN}>
            <NeedsYou className="order-1" />
            <InProgress className="order-3" />
          </div>
          <div className={COLUMN}>
            {/* The setup card while onboarding is open for an admin, else the
                post-onboarding checklist: never both. */}
            <SetupChecklistCard className="order-2" />
            <PostOnboardingChecklistCard className="order-2" />
            <Favorites className="order-4" />
          </div>
        </div>
        <div className="h-80 md:h-[28rem]">
          <TimelineRegion
            versionResolved={versionResolved}
            supported={supported}
            // A connection from URL params is not stored until the naming
            // dialog saves it: no attempt has failed yet.
            isError={isError && !pendingConnection}
            error={error}
            apiUrl={config.apiUrl}
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
  apiUrl,
}: {
  versionResolved: boolean;
  supported: boolean;
  isError: boolean;
  error: Error | null;
  apiUrl: string;
}) {
  // The version probe failed outright (dead apiUrl, bad key, CORS, network):
  // stop spinning a skeleton forever and tell the user why, with a way out.
  if (!versionResolved && isError) {
    return (
      <AlertCallout tone="error" icon={AlertTriangle} title="Can't reach the API server">
        {error?.message ? `${error.message}.` : "The health check failed."} Check your connection
        under{" "}
        <Link to="/settings/connections" className="underline underline-offset-2">
          Settings → Servers
        </Link>
        .{/* `fetch` rejects with a TypeError when no response came back. */}
        {error instanceof TypeError ? <LocalNetworkHelp apiUrl={apiUrl} /> : null}
      </AlertCallout>
    );
  }

  // Version query still in flight: placeholder, no premature notice.
  if (!versionResolved) {
    return <Skeleton className="h-full w-full rounded-xl" />;
  }

  // Confirmed older API server: the timeline surface isn't available.
  if (!supported) {
    return (
      <AlertCallout tone="info">Agent activity view requires Agent Swarm API 1.76+.</AlertCallout>
    );
  }

  return <AgentActivityTimeline />;
}

export default UnifiedHome;
