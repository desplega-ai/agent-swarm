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
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import type { AgentTask, AgentTaskStatus } from "@/api/types";

// --- Kanban column ---

const KANBAN_COLUMNS: { key: string; title: string; dotColor: string; bgColor: string; borderColor: string; statuses: AgentTaskStatus[] }[] = [
  { key: "pending", title: "PENDING", dotColor: "bg-yellow-500", bgColor: "bg-yellow-500/5", borderColor: "border-yellow-500/20", statuses: ["backlog", "unassigned", "offered", "reviewing", "pending"] },
  { key: "inProgress", title: "IN PROGRESS", dotColor: "bg-blue-500", bgColor: "bg-blue-500/5", borderColor: "border-blue-500/20", statuses: ["in_progress", "paused"] },
  { key: "completed", title: "COMPLETED", dotColor: "bg-emerald-500", bgColor: "bg-emerald-500/5", borderColor: "border-emerald-500/20", statuses: ["completed"] },
  { key: "failed", title: "FAILED", dotColor: "bg-red-500", bgColor: "bg-red-500/5", borderColor: "border-red-500/20", statuses: ["failed", "cancelled"] },
];

function KanbanColumn({
  title,
  dotColor,
  bgColor,
  borderColor,
  tasks,
  onTaskClick,
}: {
  title: string;
  dotColor: string;
  bgColor: string;
  borderColor: string;
  tasks: AgentTask[];
  onTaskClick: (id: string) => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-w-[180px] max-w-[300px]">
      <div className="flex items-center gap-2 px-1 mb-2">
        <div className={cn("h-2 w-2 rounded-full", dotColor)} />
        <span className="text-[10px] font-semibold text-muted-foreground tracking-wider">{title}</span>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-mono leading-none items-center">
          {tasks.length}
        </Badge>
      </div>
      <div className={cn("flex-1 rounded-lg border p-2 space-y-2 min-h-[100px] max-h-[500px] overflow-y-auto", bgColor, borderColor)}>
        {tasks.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60 text-center py-4">No tasks</p>
        ) : (
          tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => onTaskClick(task.id)}
              className="w-full text-left rounded-md border border-border bg-background p-2.5 hover:border-primary/40 transition-colors cursor-pointer"
            >
              <p className="text-xs line-clamp-2 text-foreground">{task.task}</p>
              <div className="flex items-center gap-1.5 mt-1.5">
                {task.taskType && (
                  <Badge variant="outline" className="text-[8px] px-1 py-0 h-4 font-medium leading-none items-center uppercase">
                    {task.taskType}
                  </Badge>
                )}
                {task.priority !== undefined && (
                  <Badge variant="outline" className="text-[8px] px-1 py-0 h-4 font-mono leading-none items-center">
                    P{task.priority}
                  </Badge>
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function KanbanBoard({ tasks, onTaskClick }: { tasks: AgentTask[]; onTaskClick: (id: string) => void }) {
  const grouped = useMemo(() => {
    const result: Record<string, AgentTask[]> = {};
    for (const col of KANBAN_COLUMNS) {
      result[col.key] = [];
    }
    for (const task of tasks) {
      const col = KANBAN_COLUMNS.find((c) => c.statuses.includes(task.status));
      if (col) result[col.key].push(task);
    }
    return result;
  }, [tasks]);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {KANBAN_COLUMNS.map((col) => (
        <KanbanColumn
          key={col.key}
          title={col.title}
          dotColor={col.dotColor}
          bgColor={col.bgColor}
          borderColor={col.borderColor}
          tasks={grouped[col.key]}
          onTaskClick={onTaskClick}
        />
      ))}
    </div>
  );
}

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
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden gap-3">
      <div className="shrink-0">
        <button
          type="button"
          onClick={() => navigate("/epics")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Epics
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <h1 className="text-xl font-semibold">{epic.name}</h1>
        <StatusBadge status={epic.status} size="md" />
        {epic.tags?.map((tag) => (
          <Badge key={tag} variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase">
            {tag}
          </Badge>
        ))}
      </div>

      {/* Progress Bar */}
      <div className="space-y-1 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="text-sm font-mono">{Math.round(progressPct)}%</span>
        </div>
        {stats && (
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span className="text-emerald-400">{stats.completed} completed</span>
            <span className="text-primary">{stats.inProgress} in progress</span>
            <span className="text-yellow-400">{stats.pending} pending</span>
            {stats.failed > 0 && <span className="text-red-400">{stats.failed} failed</span>}
            <span>{stats.total} total</span>
          </div>
        )}
      </div>

      <Tabs defaultValue="overview" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({epic.tasks?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="board">Board</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4 overflow-y-auto">
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
                      className="text-primary hover:underline"
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

        <TabsContent value="tasks" className="flex flex-col flex-1 min-h-0 mt-4">
          <DataGrid
            rowData={epic.tasks ?? []}
            columnDefs={taskColDefs}
            onRowClicked={onTaskClicked}
            emptyMessage="No tasks in this epic"
          />
        </TabsContent>

        <TabsContent value="board" className="flex-1 min-h-0 mt-4 overflow-y-auto">
          <KanbanBoard
            tasks={epic.tasks ?? []}
            onTaskClick={(taskId) => navigate(`/tasks/${taskId}`)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
