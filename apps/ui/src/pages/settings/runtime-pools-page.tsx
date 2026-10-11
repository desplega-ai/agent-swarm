import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Boxes, Plus } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import {
  useRuntimeControllers,
  useRuntimePools,
  useRuntimePoolsRuntimes,
} from "@/api/hooks/use-runtime-pools";
import type { RuntimePool } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { useIsMobile } from "@/hooks/use-mobile";
import { deliveryLabel, RUNTIME_KIND_LABEL, RUNTIME_LIFECYCLE_LABEL } from "@/lib/runtime-pools";
import {
  PoolHealthBadge,
  RUNTIME_POOLS_PATH,
  RuntimePoolsGuard,
  RuntimePoolsTabs,
} from "./runtime-pools-shared";

interface PoolRow extends RuntimePool {
  controllerName: string;
  agentCount: number;
  liveRuntimes: number;
  provisioningRuntimes: number;
}

function runtimeCounts(row: PoolRow): string {
  return `${row.liveRuntimes} live · ${row.provisioningRuntimes} provisioning`;
}

function RuntimePoolsList() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const pools = useRuntimePools();
  const controllers = useRuntimeControllers();
  const agents = useAgents();
  const poolIds = useMemo(() => (pools.data ?? []).map((pool) => pool.id), [pools.data]);
  const runtimes = useRuntimePoolsRuntimes(poolIds);

  const rows = useMemo<PoolRow[]>(() => {
    const controllerNames = new Map((controllers.data ?? []).map((c) => [c.id, c.name]));
    return (pools.data ?? []).map((pool, index) => {
      const poolRuntimes = runtimes[index]?.data ?? [];
      const controllerId = pool.placements[0] ?? "";
      return {
        ...pool,
        controllerName: controllerNames.get(controllerId) ?? controllerId,
        agentCount: (agents.data ?? []).filter((agent) => agent.runtimePoolId === pool.id).length,
        liveRuntimes: poolRuntimes.filter((runtime) => runtime.status === "active").length,
        provisioningRuntimes: poolRuntimes.filter((runtime) => runtime.status === "provisioning")
          .length,
      };
    });
  }, [pools.data, controllers.data, agents.data, runtimes]);

  const columnDefs = useMemo<ColDef<PoolRow>[]>(
    () => [
      {
        headerName: "Name",
        field: "name",
        flex: 1,
        minWidth: 170,
        cellRenderer: (p: ICellRendererParams<PoolRow>) =>
          p.data ? (
            <div className="leading-tight py-1">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{p.data.name}</span>
                {!p.data.enabled && (
                  <Badge variant="outline" size="tag">
                    Disabled
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {RUNTIME_KIND_LABEL[p.data.kind]} ·{" "}
                <span className="font-mono">{p.data.controllerName}</span>
              </div>
            </div>
          ) : null,
      },
      {
        headerName: "Mode",
        colId: "mode",
        width: 210,
        suppressSizeToFit: true,
        cellClass: "text-xs",
        valueGetter: (p) =>
          p.data
            ? `${RUNTIME_LIFECYCLE_LABEL[p.data.lifecycle]} · ${deliveryLabel(p.data.delivery)}`
            : "",
      },
      {
        headerName: "Agents",
        field: "agentCount",
        width: 90,
        suppressSizeToFit: true,
        cellClass: "tabular-nums",
      },
      {
        headerName: "Runtimes",
        colId: "runtimes",
        width: 160,
        suppressSizeToFit: true,
        valueGetter: (p) => (p.data ? runtimeCounts(p.data) : ""),
        cellClass: "text-xs tabular-nums",
      },
      {
        headerName: "Health",
        colId: "health",
        width: 120,
        suppressSizeToFit: true,
        cellRenderer: (p: ICellRendererParams<PoolRow>) =>
          p.data ? <PoolHealthBadge pool={p.data} /> : null,
      },
    ],
    [],
  );

  if (pools.isLoading) return <PageSkeleton />;

  const newPool = (
    <Button type="button" size="sm" onClick={() => navigate(`${RUNTIME_POOLS_PATH}/new`)}>
      <Plus className="h-4 w-4" />
      New pool
    </Button>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title="Runtime pools"
        description="Where agents run. A pool names a provider, a controller, and how many runtimes it keeps."
        action={newPool}
      />
      <RuntimePoolsTabs />

      {pools.error && (
        <Alert variant="destructive">
          <AlertDescription>Failed to load runtime pools: {pools.error.message}</AlertDescription>
        </Alert>
      )}

      {!pools.error && rows.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No runtime pools"
          description="Create a pool to run agents on Docker or E2B, or to group operator-managed workers."
          action={newPool}
        />
      ) : isMobile ? (
        <MobileList label="Runtime pools" emptyMessage="No runtime pools">
          {rows.map((row) => (
            <MobileListRow
              key={row.id}
              to={`${RUNTIME_POOLS_PATH}/${row.id}`}
              title={row.name}
              status={<PoolHealthBadge pool={row} />}
              meta={[
                RUNTIME_KIND_LABEL[row.kind],
                `${row.agentCount} agent${row.agentCount === 1 ? "" : "s"}`,
                runtimeCounts(row),
                !row.enabled && "Disabled",
              ]}
            />
          ))}
        </MobileList>
      ) : (
        <DataGrid
          rowData={rows}
          columnDefs={columnDefs}
          domLayout="autoHeight"
          pagination={false}
          rowHeight={56}
          emptyMessage="No runtime pools."
          getRowId={(p) => p.data.id}
          onRowClicked={(event) => {
            if (event.data) void navigate(`${RUNTIME_POOLS_PATH}/${event.data.id}`);
          }}
        />
      )}
    </div>
  );
}

/** Runtime pools list: `GET /api/runtime-pools`, gated on `runtime_pools.enabled`. */
export default function RuntimePoolsPage() {
  return (
    <RuntimePoolsGuard>
      <RuntimePoolsList />
    </RuntimePoolsGuard>
  );
}
