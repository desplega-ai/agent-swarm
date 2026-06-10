import { LayoutGrid, Table2 } from "lucide-react";
import { useEffect } from "react";
import { useFeatureGate } from "@/api/hooks";
import { useAgentActivity } from "@/api/hooks/use-agent-activity";
import { AgentCanvas } from "@/components/dashboard/agent-canvas";
import { AgentTable } from "@/components/dashboard/agent-table";
import { InboxPanel } from "@/components/dashboard/inbox-panel";
import { Button } from "@/components/ui/button";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { cn } from "@/lib/utils";
import LegacyDashboard from "./legacy-dashboard";

// Phase 5 dashboard root.
//
// Soft-degrade contract:
//   - When `useFeatureGate("1.76.0").supported === false` we render the legacy
//     4-section dashboard (extracted to `legacy-dashboard.tsx`) verbatim — no
//     canvas, no inbox. This covers older self-hosted API servers.
//   - Otherwise we render the new dashboard: agent canvas (or table fallback)
//     on top, action-items inbox below (Phase 6 fills the slot).

const VIEW_STORAGE_KEY = "agent-swarm-dashboard-view";
type DashboardView = "canvas" | "table";

function readPersistedView(): DashboardView {
  if (typeof window === "undefined") return "canvas";
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "canvas" || stored === "table") return stored;
  } catch {
    /* localStorage unavailable — fall through */
  }
  return "canvas";
}

function NewDashboard() {
  const activity = useAgentActivity({ windowHours: 24 });
  const { searchParams, setParam } = useUrlSearchState();
  const viewParam = readStringParam(searchParams, "view", readPersistedView());
  const view: DashboardView = viewParam === "table" ? "table" : "canvas";

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      /* persisted view best-effort */
    }
  }, [view]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3 md:gap-4 overflow-y-auto md:overflow-hidden">
      {/* Canvas / Table toggle */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <h2 className="text-sm font-semibold">Agents · last 24h</h2>
        <div className="inline-flex rounded-md border border-border bg-card p-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setParam("view", "canvas", { defaultValue: "canvas" })}
            className={cn("h-7 px-2.5 text-xs", view === "canvas" && "bg-muted text-foreground")}
            aria-pressed={view === "canvas"}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Canvas
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setParam("view", "table", { defaultValue: "canvas" })}
            className={cn("h-7 px-2.5 text-xs", view === "table" && "bg-muted text-foreground")}
            aria-pressed={view === "table"}
          >
            <Table2 className="h-3.5 w-3.5" />
            Table
          </Button>
        </div>
      </div>

      {activity.truncated ? (
        <div className="text-[11px] text-status-warning-strong">
          Activity counts may be capped — more than 1000 tasks in the last 24h.
        </div>
      ) : null}

      {/* Canvas / Table region */}
      <div className="shrink-0">
        {view === "canvas" ? (
          <AgentCanvas rows={activity.agents} />
        ) : (
          <AgentTable rows={activity.agents} />
        )}
      </div>

      {/* Phase 6 action-items inbox — four buckets (Blocking / Broken /
          To read / To start). Sources its own data hooks; sees its own
          5s polling tick. */}
      <div className="flex-1 min-h-0" data-dashboard-inbox-slot>
        <InboxPanel />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { supported } = useFeatureGate("1.76.0");

  if (!supported) {
    return <LegacyDashboard />;
  }

  return <NewDashboard />;
}
