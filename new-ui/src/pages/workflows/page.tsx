import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { Workflow as WorkflowIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAllWorkflowRuns, useUpdateWorkflow, useWorkflows } from "@/api/hooks/use-workflows";
import type { Workflow, WorkflowRun, WorkflowRunStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

function formatDuration(startedAt: string, finishedAt?: string): string {
  if (!finishedAt) return "—";
  return formatElapsed(startedAt, finishedAt);
}

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") ?? "workflows";

  const { data: workflows, isLoading: wfLoading } = useWorkflows();
  const { data: allRuns, isLoading: runsLoading } = useAllWorkflowRuns();
  const updateWorkflow = useUpdateWorkflow();

  // Run filters
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [workflowFilter, setWorkflowFilter] = useState<string>("all");

  const workflowMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workflows ?? []) m.set(w.id, w.name);
    return m;
  }, [workflows]);

  const handleToggleEnabled = useCallback(
    (workflow: Workflow, enabled: boolean) => {
      updateWorkflow.mutate({ id: workflow.id, data: { enabled } });
    },
    [updateWorkflow],
  );

  // Workflows tab columns
  const workflowColumns = useMemo<ColDef<Workflow>[]>(
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
        valueGetter: (params) => params.data?.definition?.nodes?.length ?? 0,
      },
      {
        field: "enabled",
        headerName: "Enabled",
        width: 100,
        cellRenderer: (params: ICellRendererParams<Workflow>) => {
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
    (event: RowClickedEvent<Workflow>) => {
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
            <span className="text-red-500 truncate text-xs">{params.value}</span>
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
        <h1 className="text-xl font-semibold">Workflows</h1>
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <WorkflowIcon className="h-8 w-8 mb-2" />
          <p className="text-sm">No workflows configured</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <h1 className="text-xl font-semibold">Workflows</h1>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setSearchParams({ tab: v })}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>

        <TabsContent value="workflows" className="flex flex-col flex-1 min-h-0 mt-2">
          <DataGrid
            rowData={workflows ?? []}
            columnDefs={workflowColumns}
            onRowClicked={onWorkflowRowClicked}
            loading={wfLoading}
            emptyMessage="No workflows configured"
          />
        </TabsContent>

        <TabsContent value="runs" className="flex flex-col flex-1 min-h-0 mt-2 gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="waiting">Waiting</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
            <Select value={workflowFilter} onValueChange={setWorkflowFilter}>
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
                onClick={() => {
                  setStatusFilter("all");
                  setWorkflowFilter("all");
                }}
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
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
