import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { AgentActivityRow } from "@/api/hooks/use-agent-activity";
import type { AgentStatus } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatCost } from "@/lib/cost-format";

// Tabular fallback for the dashboard agent canvas (Phase 5).
//
// Columns: name (w/ lead crown), role, status, taskCount24h, cost24h. Rows
// link to `/agents/:id` on click. AG Grid handles sort/quick-filter — we only
// declare the column defs.

interface AgentTableProps {
  rows: AgentActivityRow[];
  className?: string;
}

interface RowVm {
  id: string;
  name: string;
  isLead: boolean;
  role: string;
  status: AgentStatus;
  taskCount24h: number;
  cost24h: number;
}

// Phase 12a — use the shared `formatCost` utility (auto precision).

export function AgentTable({ rows, className }: AgentTableProps) {
  const navigate = useNavigate();

  const rowData = useMemo<RowVm[]>(
    () =>
      rows.map((r) => ({
        id: r.agent.id,
        name: r.agent.name,
        isLead: !!r.agent.isLead,
        role: r.agent.role ?? "",
        status: r.agent.status,
        taskCount24h: r.taskCount24h,
        cost24h: r.cost24h,
      })),
    [rows],
  );

  const columnDefs = useMemo<ColDef<RowVm>[]>(
    () => [
      {
        headerName: "Agent",
        field: "name",
        flex: 2,
        minWidth: 160,
        cellRenderer: (params: ICellRendererParams<RowVm>) => {
          const r = params.data;
          if (!r) return null;
          return (
            <span className="inline-flex items-center gap-2">
              <AgentAvatar agentId={r.id} agentName={r.name} size="xs" className="shrink-0" />
              <span className="font-semibold">{r.name}</span>
            </span>
          );
        },
      },
      {
        headerName: "Role",
        field: "role",
        flex: 1,
        minWidth: 120,
      },
      {
        headerName: "Status",
        field: "status",
        flex: 1,
        minWidth: 130,
        cellRenderer: (params: ICellRendererParams<RowVm>) => {
          const status = params.value as AgentStatus | undefined;
          if (!status) return null;
          return <StatusBadge status={status} />;
        },
      },
      {
        headerName: "Tasks (24h)",
        field: "taskCount24h",
        flex: 1,
        minWidth: 110,
        type: "numericColumn",
        sort: "desc",
        cellClass: "ag-right-aligned-cell",
        headerClass: "ag-right-aligned-header",
      },
      {
        headerName: "Cost (24h)",
        field: "cost24h",
        flex: 1,
        minWidth: 110,
        type: "numericColumn",
        valueFormatter: (params) => formatCost(Number(params.value ?? 0)),
        cellClass: "ag-right-aligned-cell font-mono",
        headerClass: "ag-right-aligned-header",
      },
    ],
    [],
  );

  return (
    <DataGrid
      rowData={rowData}
      columnDefs={columnDefs}
      onRowClicked={(event) => {
        if (event.data?.id) navigate(`/agents/${event.data.id}`);
      }}
      pagination={false}
      emptyMessage="No agents connected"
      className={className}
    />
  );
}
