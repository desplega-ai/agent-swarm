import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { Box } from "lucide-react";
import { useMemo } from "react";
import { useScriptRuns } from "@/api/hooks/use-script-runs";
import { useDurableObjects } from "@/api/hooks/use-scripts";
import type { DurableObjectEntry } from "@/api/types";
import { ScriptRunsGrid } from "@/components/scripts/script-runs-grid";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { JsonViewer } from "@/components/shared/json-viewer";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useIsPhone } from "@/hooks/use-mobile";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatSmartTime } from "@/lib/utils";

// Runs shown for one object. The server caps a page at 500.
const OBJECT_RUNS_LIMIT = 100;

function formatEpoch(ms: number | null): string {
  return ms == null ? "Never" : formatSmartTime(new Date(ms).toISOString());
}

function BusyBadge() {
  return (
    <Badge
      variant="outline"
      size="tag"
      className="border-status-active/30 text-status-active-strong"
    >
      Busy
    </Badge>
  );
}

/**
 * Objects of a durable script: one row per object id, the selected object's
 * state (read-only, secrets scrubbed) and the runs that called it.
 */
export function ScriptObjectsTab({ scriptId, methods }: { scriptId: string; methods: string[] }) {
  const isPhone = useIsPhone();
  const { searchParams, setParam } = useUrlSearchState();
  const objectParam = readStringParam(searchParams, "object", "");
  const { data, isLoading } = useDurableObjects(scriptId);
  const objects = data?.objects;
  const total = data?.total ?? 0;
  const selected = useMemo(
    () => objects?.find((object) => object.id === objectParam) ?? objects?.[0] ?? null,
    [objects, objectParam],
  );
  const { data: runsData, isLoading: runsLoading } = useScriptRuns(
    { objectScriptId: scriptId, objectId: selected?.id, limit: OBJECT_RUNS_LIMIT },
    { enabled: !!selected },
  );
  const select = (id: string) => setParam("object", id, { defaultValue: "" });

  const columns = useMemo<ColDef<DurableObjectEntry>[]>(
    () => [
      {
        field: "id",
        headerName: "Object",
        flex: 1,
        minWidth: 120,
        cellRenderer: (params: { value?: string; data?: DurableObjectEntry }) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm">{params.value}</span>
            {params.data?.busy ? <BusyBadge /> : null}
          </span>
        ),
      },
      {
        field: "stateVersion",
        headerName: "State",
        width: 72,
        valueFormatter: (params) => (params.value != null ? `v${params.value}` : ""),
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        flex: 1,
        minWidth: 100,
        valueFormatter: (params) => formatEpoch(params.value ?? null),
      },
      {
        field: "expiresAt",
        headerName: "Expires",
        flex: 1,
        minWidth: 100,
        valueFormatter: (params) => formatEpoch(params.value ?? null),
      },
    ],
    [],
  );

  const onRowClicked = (event: RowClickedEvent<DurableObjectEntry>) => {
    if (event.data) select(event.data.id);
  };

  if (!isLoading && (objects?.length ?? 0) === 0) {
    return (
      <EmptyState
        icon={Box}
        title="No objects yet"
        description="Call a method with script_run and object: { id, method } to create one."
      />
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4 lg:flex-row">
      <div className="flex flex-col gap-2 md:min-h-[260px] lg:min-h-0 lg:flex-[2]">
        {methods.length > 0 ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Methods
            {methods.map((method) => (
              <Badge key={method} variant="outline" className="font-mono">
                {method}()
              </Badge>
            ))}
          </p>
        ) : null}
        {objects && total > objects.length ? (
          <p className="text-xs text-muted-foreground">
            Showing {objects.length.toLocaleString()} of {total.toLocaleString()} objects.
          </p>
        ) : null}
        {isPhone ? (
          <MobileList
            label="Objects"
            loading={isLoading}
            emptyMessage="No objects yet"
            className="flex-none"
          >
            {(objects ?? []).map((object) => (
              <MobileListRow
                key={object.id}
                onClick={() => select(object.id)}
                selected={selected?.id === object.id}
                title={<span className="font-mono">{object.id}</span>}
                titleLines={1}
                status={object.busy ? <BusyBadge /> : undefined}
                meta={[
                  object.stateVersion != null ? `v${object.stateVersion}` : null,
                  `updated ${formatEpoch(object.updatedAt)}`,
                ]}
              />
            ))}
          </MobileList>
        ) : (
          <DataGrid
            rowData={objects ?? []}
            columnDefs={columns}
            onRowClicked={onRowClicked}
            loading={isLoading}
            emptyMessage="No objects yet"
            pagination={false}
          />
        )}
      </div>

      {selected ? (
        <div className="flex min-h-0 flex-col gap-4 lg:flex-[3]">
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="font-mono text-sm">{selected.id}</CardTitle>
              <CardAction className="flex items-center gap-1.5">
                {selected.busy ? <BusyBadge /> : null}
                {selected.stateVersion != null ? (
                  <Badge variant="outline" size="tag" className="font-mono">
                    State v{selected.stateVersion}
                  </Badge>
                ) : null}
                {selected.codeVersion != null ? (
                  <Badge variant="outline" size="tag" className="font-mono">
                    Code v{selected.codeVersion}
                  </Badge>
                ) : null}
              </CardAction>
            </CardHeader>
            <CardContent className="max-h-80 overflow-auto px-4">
              <JsonViewer data={selected.state ?? null} />
            </CardContent>
          </Card>
          <div className="flex min-h-[240px] flex-1 flex-col">
            <ScriptRunsGrid
              rows={runsData?.runs ?? []}
              loading={runsLoading}
              hideNameColumn
              hideToolbar
              objectRuns
              statusParamKey="objectRunsStatus"
              paginationQueryKey="objectRuns"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
