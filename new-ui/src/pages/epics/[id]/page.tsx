import { useMemo, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { useEpic } from "@/api/hooks/use-epics";
import { StatusBadge } from "@/components/shared/status-badge";
import { JsonViewer } from "@/components/shared/json-viewer";
import { DataGrid } from "@/components/shared/data-grid";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatSmartTime } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import type { AgentTask, AgentTaskStatus } from "@/api/types";

export default function EpicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: epic, isLoading } = useEpic(id!);

  const taskColDefs = useMemo<ColDef<AgentTask>[]>(
    () => [
      {
        field: "task",
        headerName: "Description",
        flex: 1,
        minWidth: 300,
        cellRenderer: (params: { value: string }) => (
          <span className="truncate">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: { value: AgentTaskStatus }) => (
          <StatusBadge status={params.value} />
        ),
      },
      { field: "taskType", headerName: "Type", width: 100 },
      { field: "priority", headerName: "Priority", width: 80 },
      {
        field: "createdAt",
        headerName: "Created",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [],
  );

  const onTaskClicked = useCallback(
    (event: RowClickedEvent<AgentTask>) => {
      if (event.data) navigate(`/tasks/${event.data.id}`);
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

  if (!epic) {
    return <p className="text-muted-foreground">Epic not found.</p>;
  }

  const stats = epic.taskStats;
  const progressPct = epic.progress ?? 0;

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => navigate("/epics")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Epics
      </button>

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="font-display text-2xl font-bold">{epic.name}</h1>
        <StatusBadge status={epic.status} size="md" />
        {epic.tags?.map((tag) => (
          <Badge key={tag} variant="secondary" className="text-xs">
            {tag}
          </Badge>
        ))}
      </div>

      {/* Progress Bar */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-500 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="text-sm font-mono">{Math.round(progressPct)}%</span>
        </div>
        {stats && (
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span className="text-emerald-400">{stats.completed} completed</span>
            <span className="text-amber-400">{stats.inProgress} in progress</span>
            <span className="text-yellow-400">{stats.pending} pending</span>
            {stats.failed > 0 && <span className="text-red-400">{stats.failed} failed</span>}
            <span>{stats.total} total</span>
          </div>
        )}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({epic.tasks?.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div>
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Goal</span>
                <p className="text-sm">{epic.goal}</p>
              </div>
              {epic.description && (
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">Description</span>
                  <pre className="text-sm whitespace-pre-wrap font-sans">{epic.description}</pre>
                </div>
              )}
              {epic.leadAgentId && (
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">Lead Agent</span>
                  <p className="text-sm">
                    <Link
                      to={`/agents/${epic.leadAgentId}`}
                      className="text-amber-400 hover:underline"
                    >
                      {epic.leadAgentId.slice(0, 8)}...
                    </Link>
                  </p>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Created {formatSmartTime(epic.createdAt)}
                {epic.startedAt && ` \u00b7 Started ${formatSmartTime(epic.startedAt)}`}
                {epic.completedAt && ` \u00b7 Completed ${formatSmartTime(epic.completedAt)}`}
              </div>
            </CardContent>
          </Card>

          {epic.prd && <JsonViewer data={epic.prd} title="Product Requirements (PRD)" />}
          {epic.plan && <JsonViewer data={epic.plan} title="Implementation Plan" />}
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          <DataGrid
            rowData={epic.tasks ?? []}
            columnDefs={taskColDefs}
            onRowClicked={onTaskClicked}
            emptyMessage="No tasks in this epic"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
