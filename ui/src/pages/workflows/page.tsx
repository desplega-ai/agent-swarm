import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { Search, Workflow as WorkflowIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAllWorkflowRuns, useUpdateWorkflow, useWorkflows } from "@/api/hooks/use-workflows";
import type { WorkflowRun, WorkflowRunStatus, WorkflowSummary } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

function formatDuration(startedAt: string, finishedAt?: string): string {
  if (!finishedAt) return "—";
  return formatElapsed(startedAt, finishedAt);
}

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { searchParams, setParam, setParams } = useUrlSearchState();
  const activeTab =
    readStringParam(searchParams, "tab", "workflows") === "runs" ? "runs" : "workflows";
  const search = readStringParam(searchParams, "search");
  const statusFilter = readStringParam(searchParams, "runStatus", "all");
  const workflowFilter = readStringParam(searchParams, "workflow", "all");

  const { data: workflows, isLoading: wfLoading } = useWorkflows();
  const { data: allRuns, isLoading: runsLoading } = useAllWorkflowRuns();
  const updateWorkflow = useUpdateWorkflow();

  const workflowMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workflows ?? []) m.set(w.id, w.name);
    return m;
  }, [workflows]);

  const handleToggleEnabled = useCallback(
    (workflow: WorkflowSummary, enabled: boolean) => {
      updateWorkflow.mutate({ id: workflow.id, data: { enabled } });
    },
    [updateWorkflow],
  );

  // Workflows tab columns
  const workflowColumns = useMemo<ColDef<WorkflowSummary>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: { value: string }) => (
          <span className="font-semibold">{params.value}</span>
        ),
      },
      {
        field: "description",
        headerName: "Description",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: { value?: string }) => (
          <span className="text-muted-foreground truncate">{params.value || "—"}</span>
        ),
      },
      {
        headerName: "Nodes",
        width: 100,
        valueGetter: (params) => params.data?.nodeCount ?? 0,
      },
      {
        field: "enabled",
        headerName: "Enabled",
        width: 100,
        cellRenderer: (params: ICellRendererParams<WorkflowSummary>) => {
          const wf = params.data;
          if (!wf) return null;
          return (
            <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Switch
                size="sm"
                checked={wf.enabled}
                onCheckedChange={(checked) => handleToggleEnabled(wf, checked)}
              />
            </div>
          );
        },
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [handleToggleEnabled],
  );

  const onWorkflowRowClicked = useCallback(
    (event: RowClickedEvent<WorkflowSummary>) => {
      const target = event.event?.target as HTMLElement | null;
      if (target?.closest('[data-slot="switch"], button')) return;
      if (event.data) navigate(`/workflows/${event.data.id}`);
    },
    [navigate],
  );

  // Runs tab - filtered data
  const filteredRuns = useMemo(() => {
    if (!allRuns) return [];
    return allRuns.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (workflowFilter !== "all" && r.workflowId !== workflowFilter) return false;
      return true;
    });
  }, [allRuns, statusFilter, workflowFilter]);

  const runColumns = useMemo<ColDef<WorkflowRun>[]>(
    () => [
      {
        headerName: "Workflow",
        width: 200,
        valueGetter: (params) =>
          params.data ? (workflowMap.get(params.data.workflowId) ?? "Unknown") : "",
        cellRenderer: (params: { value: string }) => (
          <span className="font-semibold">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: { value: WorkflowRunStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      {
        field: "startedAt",
        headerName: "Started",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
      {
        headerName: "Duration",
        width: 120,
        valueGetter: (params) =>
          params.data ? formatDuration(params.data.startedAt, params.data.finishedAt) : "—",
      },
      {
        field: "error",
        headerName: "Error",
        flex: 1,
        cellRenderer: (params: { value?: string }) =>
          params.value ? (
            <span className="text-status-error truncate text-xs">{params.value}</span>
          ) : null,
      },
    ],
    [workflowMap],
  );

  const onRunRowClicked = useCallback(
    (event: RowClickedEvent<WorkflowRun>) => {
      if (event.data) navigate(`/workflow-runs/${event.data.id}`);
    },
    [navigate],
  );

  const isEmpty = !wfLoading && (!workflows || workflows.length === 0);

  if (isEmpty) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <PageHeader title="Workflows" />
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-4">
          <div className="flex flex-col items-center">
            <WorkflowIcon className="h-8 w-8 mb-2" />
            <p className="text-sm">No workflows configured</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Workflows" />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setParam("tab", value, { defaultValue: "workflows" })}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>

        <TabsContent value="workflows" className="flex flex-col flex-1 min-h-0 mt-2 gap-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search workflows…"
                value={search}
                onChange={(e) => setParam("search", e.target.value, { reset: ["workflowsPage"] })}
                className="pl-9"
              />
            </div>
          </div>
          <DataGrid
            rowData={workflows ?? []}
            columnDefs={workflowColumns}
            quickFilterText={search}
            onRowClicked={onWorkflowRowClicked}
            loading={wfLoading}
            emptyMessage="No workflows configured"
            paginationQueryKey="workflows"
          />
        </TabsContent>

        <TabsContent value="runs" className="flex flex-col flex-1 min-h-0 mt-2 gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={statusFilter}
              onValueChange={(value) =>
                setParam("runStatus", value, {
                  defaultValue: "all",
                  reset: ["workflowRunsPage"],
                })
              }
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="waiting">Waiting</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="skipped">Skipped</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={workflowFilter}
              onValueChange={(value) =>
                setParam("workflow", value, {
                  defaultValue: "all",
                  reset: ["workflowRunsPage"],
                })
              }
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Workflow" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workflows</SelectItem>
                {workflows?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(statusFilter !== "all" || workflowFilter !== "all") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setParams(
                    { runStatus: "all", workflow: "all" },
                    {
                      defaultValues: { runStatus: "all", workflow: "all" },
                      reset: ["workflowRunsPage"],
                    },
                  )
                }
              >
                Clear filters
              </Button>
            )}
          </div>
          <DataGrid
            rowData={filteredRuns}
            columnDefs={runColumns}
            onRowClicked={onRunRowClicked}
            loading={runsLoading}
            emptyMessage="No workflow runs"
            paginationQueryKey="workflowRuns"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
