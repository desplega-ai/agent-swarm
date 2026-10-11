import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Boxes, Plus } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useRuntimeControllers, useRuntimePools } from "@/api/hooks/use-runtime-pools";
import type { RuntimePool } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { deliveryLabel, RUNTIME_KIND_LABEL, RUNTIME_LIFECYCLE_LABEL } from "@/lib/runtime-pools";
import {
  PoolHealthBadge,
  RUNTIME_POOLS_PATH,
  RuntimePoolsGuard,
  RuntimePoolsTabs,
} from "./runtime-pools-shared";

/** A value from a secondary query: a number, or why there is none yet. */
type Pending<T> = T | "loading" | "error";

interface PoolRow extends RuntimePool {
  controllerName: Pending<string>;
  agentCount: Pending<number>;
}

/** Plain text for a pending value, for the phone list meta line. */
function pendingText<T>(value: Pending<T>, format: (value: T) => string): string {
  if (value === "loading") return "Loading…";
  if (value === "error") return "Unavailable";
  return format(value);
}

function PendingCell<T>({
  value,
  children,
}: {
  value: Pending<T>;
  children: (value: T) => string;
}) {
  if (value === "loading") return <Skeleton className="h-3 w-12" />;
  if (value === "error") return <span className="text-muted-foreground">Unavailable</span>;
  return <>{children(value)}</>;
}

function agentsText(count: number): string {
  return `${count} agent${count === 1 ? "" : "s"}`;
}

function RuntimePoolsList() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const pools = useRuntimePools();
  const controllers = useRuntimeControllers();
  const agents = useAgents();

  // Runtime counts live on the detail page only: the API has no aggregate
  // route, and one `/runtimes` poll per listed pool does not scale.
  const rows = useMemo<PoolRow[]>(() => {
    const controllerNames = new Map((controllers.data ?? []).map((c) => [c.id, c.name]));
    return (pools.data ?? []).map((pool) => {
      const controllerId = pool.placements[0] ?? "";
      return {
        ...pool,
        controllerName: controllers.data
          ? (controllerNames.get(controllerId) ?? controllerId)
          : controllers.isError
            ? "error"
            : "loading",
        agentCount: agents.data
          ? agents.data.filter((agent) => agent.runtimePoolId === pool.id).length
          : agents.isError
            ? "error"
            : "loading",
      };
    });
  }, [pools.data, controllers.data, controllers.isError, agents.data, agents.isError]);

  const columnDefs = useMemo<ColDef<PoolRow>[]>(
    () => [
      {
        headerName: "Name",
        colId: "name",
        flex: 1,
        minWidth: 170,
        // The cell also shows the controller name: put it in the value so the
        // grid repaints the cell when the controllers query settles.
        valueGetter: (p) => (p.data ? `${p.data.name} ${String(p.data.controllerName)}` : ""),
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
              <div className="flex items-center gap-1 text-xs text-muted-foreground truncate">
                {RUNTIME_KIND_LABEL[p.data.kind]} ·{" "}
                <span className="font-mono">
                  <PendingCell value={p.data.controllerName}>{(name) => name}</PendingCell>
                </span>
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
        width: 110,
        suppressSizeToFit: true,
        cellClass: "tabular-nums",
        cellRenderer: (p: ICellRendererParams<PoolRow>) =>
          p.data ? <PendingCell value={p.data.agentCount}>{String}</PendingCell> : null,
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

      {pools.error ? (
        <Alert variant="destructive">
          <AlertDescription>Failed to load runtime pools: {pools.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {agents.error ? (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load agents, so agent counts are unavailable: {agents.error.message}
          </AlertDescription>
        </Alert>
      ) : null}
      {controllers.error ? (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load controllers, so controller names are unavailable:{" "}
            {controllers.error.message}
          </AlertDescription>
        </Alert>
      ) : null}

      {pools.error ? null : rows.length === 0 ? (
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
                pendingText(row.agentCount, agentsText),
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
