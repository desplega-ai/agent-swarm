import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ArrowLeft, Play, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  useDeleteWorkflow,
  useTriggerWorkflow,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflowRuns,
} from "@/api/hooks/use-workflows";
import type { WorkflowRun, WorkflowRunStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { WorkflowGraph } from "@/components/workflows/workflow-graph";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: workflow, isLoading } = useWorkflow(id!);
  const { data: runs, isLoading: runsLoading } = useWorkflowRuns(id!);
  const updateWorkflow = useUpdateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();
  const triggerWorkflow = useTriggerWorkflow();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const runColumns = useMemo<ColDef<WorkflowRun>[]>(
    () => [
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
          params.data?.finishedAt
            ? formatElapsed(params.data.startedAt, params.data.finishedAt)
            : "—",
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
    [],
  );

  const onRunRowClicked = useCallback(
    (event: RowClickedEvent<WorkflowRun>) => {
      if (event.data) navigate(`/workflow-runs/${event.data.id}`);
    },
    [navigate],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!workflow) {
    return <p className="text-muted-foreground">Workflow not found.</p>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <button
        type="button"
        onClick={() => navigate("/workflows")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Workflows
      </button>

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">{workflow.name}</h1>
        <div className="flex items-center gap-2">
          <Switch
            checked={workflow.enabled}
            onCheckedChange={(checked) =>
              updateWorkflow.mutate({ id: workflow.id, data: { enabled: checked } })
            }
          />
          <span className="text-xs text-muted-foreground">
            {workflow.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <Badge
          variant="outline"
          className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
        >
          {workflow.definition.nodes.length} nodes
        </Badge>
        <Badge
          variant="outline"
          className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
        >
          {workflow.definition.edges.length} edges
        </Badge>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => triggerWorkflow.mutate({ id: workflow.id })}
            disabled={!workflow.enabled || triggerWorkflow.isPending}
          >
            <Play className="h-3 w-3 mr-1" /> Trigger
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-red-500/30 text-red-400 hover:bg-red-500/10"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3 w-3 mr-1" /> Delete
          </Button>
        </div>
      </div>

      {workflow.description && (
        <p className="text-sm text-muted-foreground">{workflow.description}</p>
      )}

      <Separator />

      <WorkflowGraph definition={workflow.definition} />

      <Separator />

      <h2 className="text-lg font-semibold">Recent Runs</h2>
      <DataGrid
        rowData={runs ?? []}
        columnDefs={runColumns}
        onRowClicked={onRunRowClicked}
        loading={runsLoading}
        emptyMessage="No runs yet"
        domLayout="autoHeight"
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workflow</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{workflow.name}</strong>? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                deleteWorkflow.mutate(workflow.id, {
                  onSuccess: () => navigate("/workflows"),
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
