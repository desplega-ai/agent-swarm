import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApprovalRequests } from "@/api/hooks/use-approval-requests";
import type { ApprovalRequest, ApprovalRequestStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatSmartTime } from "@/lib/utils";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "timeout", label: "Timeout" },
];

export default function ApprovalRequestsPage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const navigate = useNavigate();

  const { data: requests, isLoading } = useApprovalRequests(
    statusFilter !== "all" ? { status: statusFilter } : undefined,
  );

  const columnDefs = useMemo<ColDef<ApprovalRequest>[]>(
    () => [
      {
        field: "title",
        headerName: "Request",
        flex: 1,
        minWidth: 250,
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: { value: ApprovalRequestStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      {
        field: "questions",
        headerName: "Questions",
        width: 110,
        valueGetter: (params) => params.data?.questions?.length ?? 0,
        cellRenderer: (params: { value: number }) => (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center"
          >
            {params.value} {params.value === 1 ? "question" : "questions"}
          </Badge>
        ),
      },
      {
        field: "workflowRunId",
        headerName: "Source",
        width: 120,
        cellRenderer: (params: { data: ApprovalRequest | undefined }) => {
          if (params.data?.workflowRunId) {
            return (
              <Badge variant="outline" size="tag">
                Workflow
              </Badge>
            );
          }
          if (params.data?.sourceTaskId) {
            return (
              <Badge variant="outline" size="tag">
                Agent
              </Badge>
            );
          }
          return (
            <Badge variant="outline" size="tag">
              Manual
            </Badge>
          );
        },
      },
      {
        field: "resolvedBy",
        headerName: "Resolved By",
        width: 130,
        valueFormatter: (params) => params.value || "—",
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 150,
        sort: "desc",
        valueFormatter: (params) => formatSmartTime(params.value),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<ApprovalRequest>) => {
      if (event.data) navigate(`/approval-requests/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Approval Requests</h1>
      </div>

      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataGrid
        rowData={requests ?? []}
        columnDefs={columnDefs}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No approval requests found"
        pagination={false}
      />
    </div>
  );
}
