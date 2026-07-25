import { Info, Waypoints } from "lucide-react";
import { useMemo, useState } from "react";
import { useRoutingHandlers } from "@/api/hooks/use-routing";
import { EdgePanel } from "@/components/routing/edge-panel";
import {
  handlersForEdgeKey,
  LIFECYCLE_EDGE_KEYS,
  type LifecycleEdgeKey,
  LifecycleGraph,
} from "@/components/routing/lifecycle-graph";
import { AlertCallout } from "@/components/ui/alert-callout";
import { PageHeader } from "@/components/ui/page-header";

export default function RoutingPage() {
  const { data, isLoading, isError } = useRoutingHandlers();
  const handlers = useMemo(() => data?.handlers ?? [], [data]);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<LifecycleEdgeKey | null>(null);

  const { totalHandlers, edgesWithErrors } = useMemo(() => {
    let withErrors = 0;
    for (const key of LIFECYCLE_EDGE_KEYS) {
      const matched = handlersForEdgeKey(handlers, key);
      if (matched.some((handler) => handler.stats.errors > 0)) withErrors += 1;
    }
    return { totalHandlers: handlers.length, edgesWithErrors: withErrors };
  }, [handlers]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        icon={Waypoints}
        title="Routing"
        description="The task lifecycle from ingestion to follow-up. Each hookable edge (creation, delegation, claim, resume, completion, prompt.compose) can carry routing handlers; the badge shows how many are registered."
      />

      <AlertCallout tone="info" icon={Info} title="This map is read-only">
        Routing rules are registered by the Lead via the routing-rules skill — there's nothing to
        edit here. Click any hookable edge to inspect the handlers on it, their matchers, and their
        run stats.{" "}
        {isLoading
          ? "Loading handlers…"
          : isError
            ? "Couldn't load handlers — showing the lifecycle map with zero counts."
            : totalHandlers === 0
              ? "No handlers are registered yet, so every edge shows 0."
              : `${totalHandlers} handler${totalHandlers === 1 ? "" : "s"} registered across ${
                  LIFECYCLE_EDGE_KEYS.length
                } hookable edges${
                  edgesWithErrors > 0
                    ? `, ${edgesWithErrors} edge${edgesWithErrors === 1 ? "" : "s"} with recent errors`
                    : ""
                }.`}
      </AlertCallout>

      <LifecycleGraph
        handlers={handlers}
        selectedEdgeKey={selectedEdgeKey}
        onSelectEdge={setSelectedEdgeKey}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="rounded-full bg-primary/10 px-1 text-primary tabular-nums">n</span>
          handler count on a hookable edge
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-status-error" aria-hidden />
          recent handler errors
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-6 border-t border-dashed border-border" aria-hidden />
          non-hookable bus event (task.created)
        </span>
      </div>

      <EdgePanel
        edgeKey={selectedEdgeKey}
        handlers={handlers}
        onOpenChange={(open) => {
          if (!open) setSelectedEdgeKey(null);
        }}
      />
    </div>
  );
}
