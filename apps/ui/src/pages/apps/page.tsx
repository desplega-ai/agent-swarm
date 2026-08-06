/**
 * `/apps` — minimal catalog of swarm apps (spike). One row per app with a
 * link into the runtime at `/apps/:id`.
 */

import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { LayoutGrid } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApps } from "@/api/hooks/use-apps";
import type { AppListItem } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { AlertCallout } from "@/components/ui/alert-callout";
import { PageHeader } from "@/components/ui/page-header";
import { formatSmartTime } from "@/lib/utils";

export default function AppsListingPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useApps();
  const rows = useMemo(() => data?.apps ?? [], [data]);

  const columnDefs = useMemo<ColDef<AppListItem>[]>(
    () => [
      {
        field: "name",
        headerName: "App",
        flex: 2,
        minWidth: 200,
        cellRenderer: (params: { value: string; data: AppListItem | undefined }) =>
          params.data ? (
            <Link
              to={`/apps/${params.data.id}`}
              className="text-primary hover:underline font-medium"
              onClick={(e) => e.stopPropagation()}
            >
              {params.value}
            </Link>
          ) : null,
      },
      {
        field: "description",
        headerName: "Description",
        flex: 3,
        minWidth: 220,
        cellRenderer: (params: { value: string | null | undefined }) => (
          <span className="text-muted-foreground">{params.value || "—"}</span>
        ),
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        width: 160,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : "—"),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<AppListItem>) => {
      if (event.data) navigate(`/apps/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Apps" />
      {error ? (
        <AlertCallout tone="error" icon={LayoutGrid} title="Failed to load apps">
          {error instanceof Error ? error.message : String(error)}
        </AlertCallout>
      ) : null}
      {!isLoading && !error && rows.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="No apps yet"
          description="Agents create apps with the `app-upsert` tool."
          entity="app"
          fullPage
        />
      ) : (
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          loading={isLoading}
          onRowClicked={onRowClicked}
          emptyMessage="No apps yet"
        />
      )}
    </div>
  );
}
