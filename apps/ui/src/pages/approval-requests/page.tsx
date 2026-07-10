import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ClipboardCheck } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useApprovalRequests } from "@/api/hooks/use-approval-requests";
import type { ApprovalRequest, ApprovalRequestStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { EmptyState } from "@/components/shared/empty-state";
import { ListFilterBar } from "@/components/shared/list-filter-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatSmartTime } from "@/lib/utils";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "timeout", label: "Timeout" },
];

const STATUS_FILTERS = ["all", "pending", "approved", "rejected", "timeout"] as const;
const SOURCE_FILTERS = ["all", "workflow", "agent", "manual"] as const;
const AGE_FILTERS = ["all", "24h", "7d", "30d"] as const;
const AGE_FILTER_MS: Record<Exclude<(typeof AGE_FILTERS)[number], "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// The endpoint defaults to 100 rows; use a stable, explicit client-filter window.
const APPROVAL_REQUESTS_LIST_LIMIT = 500;

function approvalRequestSource(request: ApprovalRequest): "workflow" | "agent" | "manual" {
  if (request.workflowRunId) return "workflow";
  if (request.sourceTaskId) return "agent";
  return "manual";
}

export default function ApprovalRequestsPage() {
  const { searchParams, setParam, setParams } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const statusParam = readStringParam(searchParams, "status", "all");
  const statusFilter = STATUS_FILTERS.includes(statusParam as (typeof STATUS_FILTERS)[number])
    ? (statusParam as (typeof STATUS_FILTERS)[number])
    : "all";
  const sourceParam = readStringParam(searchParams, "source", "all");
  const sourceFilter = SOURCE_FILTERS.includes(sourceParam as (typeof SOURCE_FILTERS)[number])
    ? (sourceParam as (typeof SOURCE_FILTERS)[number])
    : "all";
  const ageParam = readStringParam(searchParams, "age", "all");
  const ageFilter = AGE_FILTERS.includes(ageParam as (typeof AGE_FILTERS)[number])
    ? (ageParam as (typeof AGE_FILTERS)[number])
    : "all";
  const navigate = useNavigate();

  const { data: requests, isLoading } = useApprovalRequests({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: APPROVAL_REQUESTS_LIST_LIMIT,
  });
  const filteredRequests = useMemo(() => {
    const minCreatedAt = ageFilter === "all" ? null : Date.now() - AGE_FILTER_MS[ageFilter];
    return (requests ?? []).filter((request) => {
      if (statusFilter !== "all" && request.status !== statusFilter) return false;
      if (sourceFilter !== "all" && approvalRequestSource(request) !== sourceFilter) return false;
      if (minCreatedAt !== null) {
        const createdAt = Date.parse(request.createdAt);
        if (!Number.isFinite(createdAt) || createdAt < minCreatedAt) return false;
      }
      return true;
    });
  }, [ageFilter, requests, sourceFilter, statusFilter]);

  const columnDefs = useMemo<ColDef<ApprovalRequest>[]>(
    () => [
      {
        field: "title",
        headerName: "Request",
        flex: 1,
        minWidth: 250,
        getQuickFilterText: (params) =>
          params.data ? `${params.data.title} ${params.data.id}` : "",
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        getQuickFilterText: () => "",
        cellRenderer: (params: { value: ApprovalRequestStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      {
        field: "questions",
        headerName: "Questions",
        width: 110,
        getQuickFilterText: () => "",
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
        getQuickFilterText: (params) => {
          const request = params.data;
          if (!request) return "";
          return [request.workflowRunId, request.workflowRunStepId, request.sourceTaskId]
            .filter(Boolean)
            .join(" ");
        },
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
        getQuickFilterText: () => "",
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
  const isEmpty = !isLoading && (requests?.length ?? 0) === 0;
  const hasActiveFilters =
    search !== "" || statusFilter !== "all" || sourceFilter !== "all" || ageFilter !== "all";

  const clearFilters = useCallback(() => {
    setParams(
      { search: "", status: "all", source: "all", age: "all" },
      {
        defaultValues: { status: "all", source: "all", age: "all" },
        replace: false,
        reset: ["approvalRequestsPage"],
      },
    );
  }, [setParams]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Approval Requests" />

      <ListFilterBar
        searchValue={search}
        onSearchChange={(value) =>
          setParam("search", value, {
            replace: false,
            reset: ["approvalRequestsPage"],
          })
        }
        searchPlaceholder="Search title, ID, resolver, or source ID…"
        hasActiveFilters={hasActiveFilters}
        onClear={clearFilters}
      >
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            setParam("status", value, {
              defaultValue: "all",
              replace: false,
              reset: ["approvalRequestsPage"],
            })
          }
        >
          <SelectTrigger className="w-[150px]">
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
        <Select
          value={sourceFilter}
          onValueChange={(value) =>
            setParam("source", value, {
              defaultValue: "all",
              replace: false,
              reset: ["approvalRequestsPage"],
            })
          }
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="workflow">Workflow</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={ageFilter}
          onValueChange={(value) =>
            setParam("age", value, {
              defaultValue: "all",
              replace: false,
              reset: ["approvalRequestsPage"],
            })
          }
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Age" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All ages</SelectItem>
            <SelectItem value="24h">Last 24 hours</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </ListFilterBar>

      {isEmpty ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No approval requests yet"
          description="Approval requests will appear here when a workflow, agent, or user asks for a decision."
        />
      ) : (
        <DataGrid
          rowData={filteredRequests}
          columnDefs={columnDefs}
          quickFilterText={search}
          onRowClicked={onRowClicked}
          loading={isLoading}
          emptyMessage="No approval requests match the current filters"
          paginationQueryKey="approvalRequests"
        />
      )}
    </div>
  );
}
