import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AlertCircle } from "lucide-react";
import { useMemo } from "react";
import { useRuntimePoolRuntimes } from "@/api/hooks/use-runtime-pools";
import type { RuntimeController, RuntimePoolRuntime } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative } from "@/lib/relative-time";
import { RUNTIME_STATUS_BADGE, runtimeExternalId } from "@/lib/runtime-pools";

/** The pool's runtimes, polled every 5 s while the detail page is open. */
export function RuntimesCard({
  poolId,
  controllers,
}: {
  poolId: string;
  controllers: RuntimeController[];
}) {
  const runtimes = useRuntimePoolRuntimes(poolId);
  const controllerNames = useMemo(
    () => new Map(controllers.map((c) => [c.id, c.name])),
    [controllers],
  );

  const columnDefs = useMemo<ColDef<RuntimePoolRuntime>[]>(
    () => [
      {
        headerName: "State",
        field: "status",
        width: 170,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<RuntimePoolRuntime>) =>
          p.data ? (
            <span className="flex items-center gap-1.5">
              <StatusBadge status={RUNTIME_STATUS_BADGE[p.data.status]} />
              {p.data.draining ? (
                <Badge variant="outline" size="tag">
                  draining
                </Badge>
              ) : null}
            </span>
          ) : null,
      },
      {
        headerName: "Agent",
        field: "agentId",
        flex: 1,
        minWidth: 160,
        cellRenderer: (p: ICellRendererParams<RuntimePoolRuntime>) =>
          p.data ? (
            <AgentLink agentId={p.data.agentId} onClick={(event) => event.stopPropagation()} />
          ) : null,
      },
      {
        headerName: "Controller",
        colId: "controller",
        width: 150,
        suppressSizeToFit: true,
        cellClass: "font-mono text-xs",
        valueGetter: (p) =>
          p.data?.controllerId
            ? (controllerNames.get(p.data.controllerId) ?? p.data.controllerId)
            : "",
      },
      {
        headerName: "External id",
        colId: "externalId",
        width: 160,
        suppressSizeToFit: true,
        cellClass: "font-mono text-xs",
        valueGetter: (p) => (p.data ? (runtimeExternalId(p.data) ?? "") : ""),
        tooltipValueGetter: (p) => (p.data ? runtimeExternalId(p.data) : null),
      },
      {
        headerName: "Attempts",
        field: "provisionAttempts",
        width: 100,
        suppressSizeToFit: true,
        cellClass: "ag-right-aligned-cell font-mono text-xs",
        headerClass: "ag-right-aligned-header",
        valueGetter: (p) => p.data?.provisionAttempts ?? 0,
      },
      {
        headerName: "Last error",
        field: "provisionError",
        flex: 1,
        minWidth: 180,
        cellClass: "text-xs text-status-error-strong",
        tooltipField: "provisionError",
      },
      {
        headerName: "Age",
        field: "createdAt",
        width: 110,
        suppressSizeToFit: true,
        cellClass: "text-xs text-muted-foreground",
        valueFormatter: (p) => (p.data ? formatRelative(p.data.createdAt) : ""),
      },
    ],
    [controllerNames],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Runtimes</CardTitle>
        <CardAction className="text-xs text-muted-foreground">Refreshes every 5 seconds</CardAction>
      </CardHeader>
      <CardContent>
        {runtimes.error ? (
          <AlertCallout tone="error" icon={AlertCircle}>
            Failed to load runtimes: {runtimes.error.message}
          </AlertCallout>
        ) : (
          <DataGrid
            rowData={runtimes.data}
            columnDefs={columnDefs}
            loading={runtimes.isLoading}
            domLayout="autoHeight"
            pagination={false}
            emptyMessage="No runtimes. They appear when the pool provisions one for a bound agent."
            getRowId={(p) => p.data.id}
          />
        )}
      </CardContent>
    </Card>
  );
}
