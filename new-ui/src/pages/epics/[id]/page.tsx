import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ArrowLeft, GitBranch, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useAssignTaskToEpic, useDeleteEpic, useEpic, useUpdateEpic } from "@/api/hooks/use-epics";
import { useTasks } from "@/api/hooks/use-tasks";
import type { AgentTask, AgentTaskStatus, EpicStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { JsonViewer } from "@/components/shared/json-viewer";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

// --- Kanban column ---

const KANBAN_COLUMNS: {
  key: string;
  title: string;
  dotColor: string;
  bgColor: string;
  borderColor: string;
  statuses: AgentTaskStatus[];
}[] = [
  {
    key: "pending",
    title: "PENDING",
    dotColor: "bg-yellow-500",
    bgColor: "bg-yellow-500/5",
    borderColor: "border-yellow-500/20",
    statuses: ["backlog", "unassigned", "offered", "reviewing", "pending"],
  },
  {
    key: "inProgress",
    title: "IN PROGRESS",
    dotColor: "bg-blue-500",
    bgColor: "bg-blue-500/5",
    borderColor: "border-blue-500/20",
    statuses: ["in_progress", "paused"],
  },
  {
    key: "completed",
    title: "COMPLETED",
    dotColor: "bg-emerald-500",
    bgColor: "bg-emerald-500/5",
    borderColor: "border-emerald-500/20",
    statuses: ["completed"],
  },
  {
    key: "failed",
    title: "FAILED",
    dotColor: "bg-red-500",
    bgColor: "bg-red-500/5",
    borderColor: "border-red-500/20",
    statuses: ["failed", "cancelled"],
  },
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
    <div className="flex flex-col flex-1 min-w-[180px] max-w-[300px] min-h-0">
      <div className="flex items-center gap-2 px-1 mb-2 shrink-0">
        <div className={cn("h-2 w-2 rounded-full", dotColor)} />
        <span className="text-[10px] font-semibold text-muted-foreground tracking-wider">
          {title}
        </span>
        <Badge
          variant="outline"
          className="text-[9px] px-1.5 py-0 h-5 font-mono leading-none items-center"
        >
          {tasks.length}
        </Badge>
      </div>
      <div
        className={cn(
          "flex-1 rounded-lg border p-2 space-y-2 min-h-0 overflow-y-auto",
          bgColor,
          borderColor,
        )}
      >
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
                  <Badge
                    variant="outline"
                    className="text-[8px] px-1 py-0 h-4 font-medium leading-none items-center uppercase"
                  >
                    {task.taskType}
                  </Badge>
                )}
                {task.priority !== undefined && (
                  <Badge
                    variant="outline"
                    className="text-[8px] px-1 py-0 h-4 font-mono leading-none items-center"
                  >
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

function KanbanBoard({
  tasks,
  onTaskClick,
}: {
  tasks: AgentTask[];
  onTaskClick: (id: string) => void;
}) {
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
    <div className="flex gap-3 overflow-x-auto pb-2 flex-1 min-h-0">
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

function EditEpicForm({
  epic,
  onSubmit,
  onCancel,
}: {
  epic: {
    name: string;
    goal: string;
    description?: string;
    priority: number;
    tags: string[];
    leadAgentId?: string;
  };
  onSubmit: (
    data: Partial<{
      name: string;
      goal: string;
      description: string;
      priority: number;
      tags: string[];
      leadAgentId: string | null;
    }>,
  ) => void;
  onCancel: () => void;
}) {
  const { data: agents } = useAgents();
  const [name, setName] = useState(epic.name);
  const [goal, setGoal] = useState(epic.goal);
  const [description, setDescription] = useState(epic.description ?? "");
  const [priority, setPriority] = useState(epic.priority);
  const [tags, setTags] = useState(epic.tags?.join(", ") ?? "");
  const [leadAgentId, setLeadAgentId] = useState(epic.leadAgentId ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    onSubmit({
      name,
      goal,
      description: description || undefined,
      priority,
      tags: tagList,
      leadAgentId: leadAgentId || null,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Edit Epic</DialogTitle>
        <DialogDescription>Update epic details.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-4">
        <div className="space-y-2">
          <Label>Name *</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label>Goal *</Label>
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} required rows={2} />
        </div>
        <div className="space-y-2">
          <Label>Description</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Priority (0–100)</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </div>
          <div className="space-y-2">
            <Label>Lead Agent</Label>
            <Select
              value={leadAgentId}
              onValueChange={(v) => setLeadAgentId(v === "_none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">None</SelectItem>
                {agents?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.isLead ? " (Lead)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label>Tags (comma-separated)</Label>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          className="bg-primary hover:bg-primary/90"
          disabled={!name.trim() || !goal.trim()}
        >
          Update
        </Button>
      </DialogFooter>
    </form>
  );
}

const PAGE_SIZE = 100;

export default function EpicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: epic, isLoading } = useEpic(id!);
  const updateEpic = useUpdateEpic();
  const deleteEpic = useDeleteEpic();
  const assignTask = useAssignTaskToEpic();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const [addTaskInput, setAddTaskInput] = useState("");
  const [addTaskMode, setAddTaskMode] = useState<"existing" | "new">("new");

  // Task tab filters
  const [taskSearch, setTaskSearch] = useState("");
  const [taskStatus, setTaskStatus] = useState("all");
  const [taskPage, setTaskPage] = useState(0);

  const taskFilters = useMemo(() => {
    const f: { epicId?: string; status?: string; search?: string; limit: number; offset: number } =
      {
        epicId: id,
        limit: PAGE_SIZE,
        offset: taskPage * PAGE_SIZE,
      };
    if (taskStatus !== "all") f.status = taskStatus;
    if (taskSearch) f.search = taskSearch;
    return f;
  }, [id, taskStatus, taskSearch, taskPage]);

  const { data: tasksData, isLoading: tasksLoading } = useTasks(taskFilters);
  const { data: agents } = useAgents();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  const taskTotal = tasksData?.total ?? 0;
  const taskTotalPages = Math.max(1, Math.ceil(taskTotal / PAGE_SIZE));

  const taskColDefs = useMemo<ColDef<AgentTask>[]>(
    () => [
      {
        field: "task",
        headerName: "Description",
        flex: 1,
        minWidth: 250,
        cellRenderer: (params: { value: string }) => (
          <span className="truncate">{params.value}</span>
        ),
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: { value: AgentTaskStatus }) => <StatusBadge status={params.value} />,
      },
      {
        field: "taskType",
        headerName: "Type",
        width: 110,
        cellRenderer: (params: { value: string | undefined }) =>
          params.value ? (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
            >
              {params.value}
            </Badge>
          ) : null,
      },
      {
        field: "agentId",
        headerName: "Agent",
        width: 150,
        valueFormatter: (params) =>
          params.value
            ? (agentMap.get(params.value) ?? `${params.value.slice(0, 8)}...`)
            : "Unassigned",
      },
      {
        headerName: "Elapsed",
        width: 100,
        valueGetter: (params) => {
          const task = params.data;
          if (!task) return "";
          const start = task.acceptedAt ?? task.createdAt;
          const end = task.finishedAt;
          const isActive =
            !end &&
            (task.status === "in_progress" ||
              task.status === "pending" ||
              task.status === "offered");
          return isActive ? formatElapsed(start) : end ? formatElapsed(start, end) : "—";
        },
      },
      {
        field: "dependsOn",
        headerName: "Deps",
        width: 90,
        cellRenderer: (params: { value: string[] | undefined }) => {
          const deps = params.value;
          if (!deps || deps.length === 0) return null;
          return (
            <div className="flex items-center gap-1 text-muted-foreground">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="text-[10px] font-mono">{deps.length}</span>
            </div>
          );
        },
        sortable: false,
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 150,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : ""),
      },
    ],
    [agentMap],
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
        <Select
          value={epic.status}
          onValueChange={(v) =>
            updateEpic.mutate({ id: epic.id, data: { status: v as EpicStatus } })
          }
        >
          <SelectTrigger className="w-[130px] h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        {epic.tags?.map((tag) => (
          <Badge
            key={tag}
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {tag}
          </Badge>
        ))}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="h-3 w-3 mr-1" /> Edit
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
          <TabsTrigger value="tasks">Tasks ({taskTotal})</TabsTrigger>
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
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Description
                  </span>
                  <pre className="text-sm whitespace-pre-wrap font-sans">{epic.description}</pre>
                </div>
              )}
              {epic.leadAgentId && (
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Lead Agent
                  </span>
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

        <TabsContent value="tasks" className="flex flex-col flex-1 min-h-0 mt-4 gap-3">
          <div className="flex items-center gap-3 shrink-0">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search tasks..."
                value={taskSearch}
                onChange={(e) => {
                  setTaskSearch(e.target.value);
                  setTaskPage(0);
                }}
                className="pl-9"
              />
            </div>
            <Select
              value={taskStatus}
              onValueChange={(v) => {
                setTaskStatus(v);
                setTaskPage(0);
              }}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => {
                setAddTaskInput("");
                setAddTaskMode("new");
                setAddTaskOpen(true);
              }}
            >
              <Plus className="h-3 w-3 mr-1" /> Add Task
            </Button>
          </div>

          <DataGrid
            rowData={tasksData?.tasks ?? []}
            columnDefs={taskColDefs}
            onRowClicked={onTaskClicked}
            loading={tasksLoading}
            emptyMessage="No tasks in this epic"
            pagination={false}
          />

          <div className="flex items-center justify-between shrink-0 text-sm text-muted-foreground">
            <span>
              {taskTotal > 0
                ? `${taskPage * PAGE_SIZE + 1}–${Math.min((taskPage + 1) * PAGE_SIZE, taskTotal)} of ${taskTotal}`
                : "0 tasks"}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={taskPage === 0}
                onClick={() => setTaskPage(taskPage - 1)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="px-2 text-xs">
                Page {taskPage + 1} of {taskTotalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={taskPage >= taskTotalPages - 1}
                onClick={() => setTaskPage(taskPage + 1)}
              >
                <ArrowLeft className="h-4 w-4 rotate-180" />
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="board" className="flex flex-col flex-1 min-h-0 mt-4 overflow-hidden">
          <KanbanBoard
            tasks={epic.tasks ?? []}
            onTaskClick={(taskId) => navigate(`/tasks/${taskId}`)}
          />
        </TabsContent>
      </Tabs>

      {/* Edit Epic Dialog */}
      {editOpen && (
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent>
            <EditEpicForm
              epic={epic}
              onSubmit={(data) => {
                updateEpic.mutate({
                  id: epic.id,
                  data: { ...data, leadAgentId: data.leadAgentId ?? undefined },
                });
                setEditOpen(false);
              }}
              onCancel={() => setEditOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Epic</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{epic.name}</strong>? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                deleteEpic.mutate(epic.id, { onSuccess: () => navigate("/epics") });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Task Dialog */}
      <Dialog open={addTaskOpen} onOpenChange={setAddTaskOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Task to Epic</DialogTitle>
            <DialogDescription>Create a new task or assign an existing one.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={addTaskMode === "new" ? "default" : "outline"}
                onClick={() => {
                  setAddTaskMode("new");
                  setAddTaskInput("");
                }}
              >
                New Task
              </Button>
              <Button
                size="sm"
                variant={addTaskMode === "existing" ? "default" : "outline"}
                onClick={() => {
                  setAddTaskMode("existing");
                  setAddTaskInput("");
                }}
              >
                Existing Task
              </Button>
            </div>
            <div className="space-y-2">
              <Label>{addTaskMode === "new" ? "Task Description" : "Task ID"}</Label>
              {addTaskMode === "new" ? (
                <Textarea
                  placeholder="Describe the task..."
                  value={addTaskInput}
                  onChange={(e) => setAddTaskInput(e.target.value)}
                  rows={3}
                />
              ) : (
                <Input
                  placeholder="Enter task ID"
                  value={addTaskInput}
                  onChange={(e) => setAddTaskInput(e.target.value)}
                />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddTaskOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/90"
              disabled={!addTaskInput.trim()}
              onClick={() => {
                const data =
                  addTaskMode === "new"
                    ? { task: addTaskInput.trim() }
                    : { taskId: addTaskInput.trim() };
                assignTask.mutate({ epicId: epic.id, data });
                setAddTaskOpen(false);
              }}
            >
              {addTaskMode === "new" ? "Create & Add" : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
