import type { ColDef } from "ag-grid-community";
import { FileClock, Unplug } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { RoutingHandler } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { HOOKABLE_EDGES, handlersForEdgeKey, type LifecycleEdgeKey } from "./lifecycle-graph";

/** Compact, human-readable summary of a handler's matcher (e.g. `via=delegation · #C123`). */
function formatMatcher(handler: RoutingHandler): string {
  const matcher = handler.matcher;
  if (!matcher) return "any";
  const parts: string[] = [];
  if (matcher.via) parts.push(`via=${matcher.via}`);
  if (matcher.source) parts.push(`source=${matcher.source}`);
  if (matcher.slackChannelId) parts.push(`#${matcher.slackChannelId}`);
  if (matcher.vcsRepo) parts.push(`repo=${matcher.vcsRepo}`);
  if (matcher.agentId) parts.push(`agent=${matcher.agentId}`);
  if (matcher.taskType) parts.push(`type=${matcher.taskType}`);
  if (matcher.filter) parts.push(`filter=${matcher.filter}`);
  return parts.length ? parts.join(" · ") : "any";
}

function formatAvg(avgDurationMs: number | null): string {
  if (avgDurationMs == null) return "—";
  return `${Math.round(avgDurationMs)}ms`;
}

interface EdgePanelProps {
  edgeKey: LifecycleEdgeKey | null;
  handlers: RoutingHandler[];
  onOpenChange: (open: boolean) => void;
}

export function EdgePanel({ edgeKey, handlers, onOpenChange }: EdgePanelProps) {
  const meta = edgeKey ? HOOKABLE_EDGES[edgeKey] : null;
  const rows = useMemo(
    () => (edgeKey ? handlersForEdgeKey(handlers, edgeKey) : []),
    [handlers, edgeKey],
  );

  const columnDefs = useMemo<ColDef<RoutingHandler>[]>(
    () => [
      {
        field: "name",
        headerName: "Handler",
        flex: 1.4,
        minWidth: 170,
        cellRenderer: (params: { data: RoutingHandler | undefined }) => {
          const handler = params.data;
          if (!handler) return null;
          return (
            <div className="flex flex-col leading-tight py-1">
              <span className="text-xs font-medium truncate">{handler.name}</span>
              {handler.description ? (
                <span className="text-[10px] text-muted-foreground truncate">
                  {handler.description}
                </span>
              ) : null}
              <span className="text-[10px] text-muted-foreground/70">
                priority {handler.priority}
              </span>
            </div>
          );
        },
      },
      {
        field: "flavor",
        headerName: "Kind",
        width: 84,
        cellRenderer: (params: { data: RoutingHandler | undefined }) => {
          const handler = params.data;
          if (!handler) return null;
          return (
            <div className="flex flex-col items-start gap-0.5 py-1">
              <Badge variant="outline" size="tag">
                {handler.flavor}
              </Badge>
              <Badge
                variant="outline"
                size="tag"
                className={handler.mode === "hard" ? "text-foreground" : "text-muted-foreground"}
              >
                {handler.mode}
              </Badge>
            </div>
          );
        },
      },
      {
        colId: "matcher",
        headerName: "Matcher",
        flex: 1.2,
        minWidth: 150,
        valueGetter: (params) => (params.data ? formatMatcher(params.data) : ""),
        cellRenderer: (params: { value: string }) => (
          <span className="font-mono text-[10px] text-muted-foreground">{params.value}</span>
        ),
      },
      {
        field: "enabled",
        headerName: "State",
        width: 84,
        cellRenderer: (params: { data: RoutingHandler | undefined }) => {
          if (!params.data) return null;
          return params.data.enabled ? (
            <Badge variant="outline" size="tag">
              enabled
            </Badge>
          ) : (
            <Badge variant="outline" size="tag" className="text-muted-foreground/70">
              disabled
            </Badge>
          );
        },
      },
      {
        colId: "stats",
        headerName: "Stats",
        width: 150,
        valueGetter: (params) => params.data?.stats.hits ?? 0,
        cellRenderer: (params: { data: RoutingHandler | undefined }) => {
          const stats = params.data?.stats;
          if (!stats) return null;
          return (
            <div className="flex flex-col text-[10px] leading-tight tabular-nums">
              <span>
                {stats.hits} hits · {stats.decisive} decisive
              </span>
              <span className="text-muted-foreground">
                {stats.deviations} dev ·{" "}
                <span className={stats.errors > 0 ? "text-status-error font-medium" : undefined}>
                  {stats.errors} err
                </span>{" "}
                · {formatAvg(stats.avgDurationMs)}
              </span>
            </div>
          );
        },
      },
      {
        field: "scriptName",
        headerName: "Script",
        width: 120,
        cellRenderer: (params: { data: RoutingHandler | undefined }) => {
          const handler = params.data;
          if (!handler) return null;
          return (
            <Link
              to={`/scripts?search=${encodeURIComponent(handler.scriptName)}`}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <FileClock className="size-3 shrink-0" />
              <span className="truncate">{handler.scriptName}</span>
            </Link>
          );
        },
      },
    ],
    [],
  );

  return (
    <Sheet open={edgeKey !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-3xl xl:max-w-4xl">
        {meta ? (
          <>
            <SheetHeader className="gap-1.5">
              <SheetTitle className="flex items-center gap-2">
                {meta.title}
                <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                  {meta.label}
                </code>
              </SheetTitle>
              <SheetDescription>{meta.description}</SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-auto px-4 pb-4">
              {rows.length === 0 ? (
                <EmptyState
                  icon={Unplug}
                  title="No handlers on this edge"
                  description="Routing rules are added by the Lead via the routing-rules skill. Once registered, they appear here in priority order."
                />
              ) : (
                <>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {rows.length} {rows.length === 1 ? "handler" : "handlers"}, in execution order
                    (ascending priority).
                  </p>
                  <DataGrid<RoutingHandler>
                    rowData={rows}
                    columnDefs={columnDefs}
                    pagination={false}
                    domLayout="autoHeight"
                    rowHeight={52}
                    className={cn("[&_.ag-root-wrapper]:border-0")}
                  />
                </>
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
