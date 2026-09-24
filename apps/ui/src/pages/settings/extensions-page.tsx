import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Blocks, Plus } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useExtensions } from "@/api/hooks/use-extensions";
import type { Extension, ExtensionStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { formatSmartTime } from "@/lib/utils";

/** Status to badge variant. `error` and `auto-disabled` both need attention. */
export function statusBadgeVariant(
  status: ExtensionStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "enabled") return "default";
  if (status === "error" || status === "auto-disabled") return "destructive";
  return "outline";
}

/**
 * Installed extensions — the operator view of `GET /api/extensions`. Each row
 * links to the detail page, where the bundle is inspected, enabled, versioned,
 * and its run log read. New bundles install from the catalog at
 * `/settings/extensions/new`.
 */
export default function ExtensionsPage() {
  const navigate = useNavigate();
  const { data: extensions, isLoading, error } = useExtensions();

  const columnDefs = useMemo<ColDef<Extension>[]>(
    () => [
      {
        headerName: "Name",
        field: "name",
        flex: 1,
        minWidth: 240,
        cellRenderer: (p: ICellRendererParams<Extension>) =>
          p.data ? (
            <div className="leading-tight py-1">
              <div className="font-medium">{p.data.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {p.data.description || "—"}
              </div>
            </div>
          ) : null,
      },
      {
        headerName: "Status",
        field: "status",
        width: 130,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<Extension>) =>
          p.data ? (
            <Badge variant={statusBadgeVariant(p.data.status)} size="tag">
              {p.data.status}
            </Badge>
          ) : null,
      },
      {
        headerName: "Version",
        field: "activeVersion",
        width: 170,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<Extension>) =>
          p.data ? (
            <span className="font-mono text-xs">
              v{p.data.activeVersion}
              {p.data.version !== p.data.activeVersion && (
                <span className="text-muted-foreground"> (latest v{p.data.version})</span>
              )}
            </span>
          ) : null,
      },
      {
        headerName: "Priority",
        field: "priority",
        width: 110,
        suppressSizeToFit: true,
        cellClass: "ag-right-aligned-cell font-mono text-xs",
        headerClass: "ag-right-aligned-header",
      },
      {
        headerName: "Failures",
        field: "consecutiveFailures",
        width: 110,
        suppressSizeToFit: true,
        cellClass: "ag-right-aligned-cell font-mono text-xs",
        headerClass: "ag-right-aligned-header",
      },
      {
        headerName: "Updated",
        field: "updatedAt",
        width: 150,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<Extension>) => (
          <span className="text-xs text-muted-foreground">
            {p.data ? formatSmartTime(p.data.updatedAt) : null}
          </span>
        ),
      },
    ],
    [],
  );

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title="Extensions"
        description="Bundles that hook into swarm orchestration — task creation, follow-up, Slack routing, heartbeat remediation, and tool calls."
        action={
          <Button type="button" size="sm" onClick={() => navigate("/settings/extensions/new")}>
            <Plus className="h-4 w-4" />
            Install extension
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load extensions: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      )}

      {!error && (extensions?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No extensions installed"
          description="Install a predefined bundle to change routing, follow-up, heartbeat, or tool-call behaviour without a core change."
          action={
            <Button type="button" size="sm" onClick={() => navigate("/settings/extensions/new")}>
              <Plus className="h-4 w-4" />
              Install extension
            </Button>
          }
        />
      ) : (
        <DataGrid
          rowData={extensions ?? []}
          columnDefs={columnDefs}
          domLayout="autoHeight"
          pagination={false}
          rowHeight={56}
          emptyMessage="No extensions installed."
          onRowClicked={(event) => {
            if (event.data) void navigate(`/settings/extensions/${event.data.id}`);
          }}
        />
      )}
    </div>
  );
}
