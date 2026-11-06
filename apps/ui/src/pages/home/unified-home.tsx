/**
 * Unified Home: the `/` landing page and the command center. This is the only
 * home surface; there is no `/old-home` or `/old-dashboard`. To change what
 * `/` shows, change this file.
 *
 * The admin nudge banner and the metrics strip on top, then two columns from
 * `xl`. The main column holds what needs input: Needs you, the checklist,
 * and the swarm activity. The side column holds Favorites, then In progress
 * and Up next (both folded by default). From `xl` the strip stays put and
 * each column scrolls on its own; below it the page scrolls as one column.
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
import { InProgress } from "@/components/home/in-progress";
import { NeedsYou } from "@/components/home/needs-you";
import { UpNext } from "@/components/home/up-next";
import { SetupChecklistCard } from "@/components/onboarding/setup-checklist-card";
import { LocalNetworkHelp } from "@/components/shared/local-network-help";
import { AlertCallout } from "@/components/ui/alert-callout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfig } from "@/hooks/use-config";

/** A column from `xl`: it scrolls on its own under the fixed strip. */
const COLUMN =
  "flex min-w-0 flex-col gap-4 xl:min-h-0 xl:overflow-y-auto xl:pb-6 xl:[scrollbar-gutter:stable] [&>*]:shrink-0";

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
          <div className={COLUMN}>
            <NeedsYou />
            {/* The setup card while onboarding is open for an admin, else the
                post-onboarding checklist: never both. */}
            <SetupChecklistCard />
            <PostOnboardingChecklistCard />
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
          <div className={COLUMN}>
            <Favorites />
            <InProgress />
            <UpNext />
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
    <ActivityDensity viewToggle={toggle} />
  ) : (
    <div className="h-80 shrink-0 md:h-[28rem]">
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
