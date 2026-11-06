/**
 * Unified Home: the `/` landing page and the command center. This is the only
 * home surface; there is no `/old-home` or `/old-dashboard`. To change what
 * `/` shows, change this file.
 *
 * The admin nudge banner and the metrics strip on top, then two columns from
 * `xl`. The main column: Needs you (up to half the height, scrolling inside;
 * one quiet line when nothing waits) over the swarm activity, which takes the
 * rest. The side column: Favorites, then "Getting started" (Set up, then Get
 * the swarm working). From `xl` the strip stays put and the columns scroll on
 * their own; below it the page scrolls as one column.
 *
 * The page owns its scroll: from `lg` the layout's `main` does not scroll.
 *
 * The activity is feature-gated on API ≥1.76.0. The gate is evaluated against
 * the *resolved* version: while the version query is pending we render a
 * skeleton, never the "requires 1.76+" notice. That only shows on a confirmed
 * unsupported version.
 */

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { PostOnboardingChecklistCard } from "@/components/checklist/post-onboarding-checklist-card";
import { AgentActivityTimeline } from "@/components/dashboard/agent-activity-timeline";
import { DashboardNudges } from "@/components/dashboard/dashboard-nudges";
import { ActivityDensity } from "@/components/home/activity-density";
import { Favorites } from "@/components/home/favorites";
import { HomeMetrics } from "@/components/home/home-metrics";
import { NeedsYou } from "@/components/home/needs-you";
import { LocalNetworkHelp } from "@/components/shared/local-network-help";
import { AlertCallout } from "@/components/ui/alert-callout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfig } from "@/hooks/use-config";

/** The side column from `xl`: it scrolls on its own under the fixed strip. */
const SIDE_COLUMN =
  "flex min-w-0 flex-col gap-4 xl:min-h-0 xl:overflow-y-auto xl:pb-6 xl:[scrollbar-gutter:stable] [&>*]:shrink-0";
/** The main column from `xl`: Needs you and the activity share its height. */
const MAIN_COLUMN = "flex min-w-0 flex-col gap-4 xl:min-h-0 xl:pb-6";

export function UnifiedHome() {
  const { supported, currentVersion, isError, error } = useFeatureGate("1.76.0");
  const { config, pendingConnection } = useConfig();

  // The greeting lives in the top bar's breadcrumb slot (Breadcrumbs renders
  // it on `/`).

  // Gate on the *resolved* version: `supported` is `false` while the version
  // query is pending, so distinguish "still resolving" from "confirmed too old".
  const versionResolved = currentVersion !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:overflow-hidden">
      <div className="flex flex-col gap-4 px-4 pb-4 pt-4 md:px-6 md:pb-6 xl:min-h-0 xl:flex-1 xl:pb-0">
        <DashboardNudges />
        <HomeMetrics className="shrink-0" />
        <div className="grid grid-cols-1 gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] xl:grid-rows-[minmax(0,1fr)]">
          <div className={MAIN_COLUMN}>
            <NeedsYou className="shrink-0 xl:max-h-[50%] xl:min-h-0" />
            <div className="flex min-h-0 flex-col xl:flex-1">
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
          <div className={SIDE_COLUMN}>
            <Favorites />
            <PostOnboardingChecklistCard />
          </div>
        </div>
      </div>
    </div>
  );
}

type ActivityView = "density" | "detail";
const VIEW_KEY = "agent-swarm:home:activity-view";
const VIEW_OPTIONS = [
  { value: "density", label: "Density", tooltip: "Counts per 15 minutes: calm at any volume" },
  { value: "detail", label: "Detail", tooltip: "Every task as a bar, with zoom and history" },
] as const;

function readView(): ActivityView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "detail" ? "detail" : "density";
  } catch {
    return "density";
  }
}

/** Density by default; Detail is the full task timeline. The pick is kept per browser. */
function HomeActivity() {
  const [view, setView] = useState<ActivityView>(readView);
  const pick = (next: ActivityView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* best-effort */
    }
  };
  const toggle = (
    <SegmentedControl
      size="sm"
      aria-label="Activity view"
      value={view}
      onValueChange={pick}
      options={VIEW_OPTIONS}
    />
  );
  return view === "density" ? (
    <ActivityDensity viewToggle={toggle} className="xl:min-h-0 xl:flex-1" />
  ) : (
    <div className="h-80 shrink-0 md:h-[28rem] xl:h-auto xl:min-h-[20rem] xl:flex-1">
      <AgentActivityTimeline viewToggle={toggle} />
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
    return <Skeleton className="h-64 w-full shrink-0 rounded-xl" />;
  }

  // Confirmed older API server: the timeline surface isn't available.
  if (!supported) {
    return (
      <AlertCallout tone="info">Agent activity view requires Agent Swarm API 1.76+.</AlertCallout>
    );
  }

  return <HomeActivity />;
}

export default UnifiedHome;
