import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ChevronLeft, ChevronRight, Clock, GitBranch, Plus, Search, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useScheduledTasks } from "@/api/hooks/use-schedules";
import { useCreateTask, useTasks } from "@/api/hooks/use-tasks";
import type { AgentTask, AgentTaskStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

interface TaskFormData {
  task: string;
  agentId: string;
  taskType: string;
  tags: string;
  priority: number;
  dependsOn: string[];
}

const emptyTaskForm: TaskFormData = {
  task: "",
  agentId: "",
  taskType: "",
  tags: "",
  priority: 50,
  dependsOn: [],
};

function CreateTaskDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: TaskFormData) => void;
}) {
  const { data: agents } = useAgents();
  const { data: tasksData } = useTasks({ status: "pending", limit: 200 });
  const { data: runningTasksData } = useTasks({ status: "in_progress", limit: 200 });
  const [form, setForm] = useState<TaskFormData>(emptyTaskForm);
  const [depSearch, setDepSearch] = useState("");

  const leadAgent = agents?.find((a) => a.isLead) ?? agents?.[0];

  // Merge pending + running tasks for dependency picker
  const availableDeps = useMemo(() => {
    const all = [...(tasksData?.tasks ?? []), ...(runningTasksData?.tasks ?? [])];
    const seen = new Set<string>();
    return all.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [tasksData, runningTasksData]);

  const filteredDeps = useMemo(() => {
    if (!depSearch) return availableDeps;
    const q = depSearch.toLowerCase();
    return availableDeps.filter(
      (t) =>
        t.task.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q),
    );
  }, [availableDeps, depSearch]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.task.trim()) return;
    // Ensure agentId is set — default to lead if empty
    const agentId = form.agentId || leadAgent?.id || "";
    if (!agentId) return;
    onSubmit({ ...form, agentId });
    setForm(emptyTaskForm);
    setDepSearch("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Task</DialogTitle>
            <DialogDescription>Send a new task to an agent for execution.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Description *</Label>
              <Textarea
                placeholder="Describe the task..."
                value={form.task}
                onChange={(e) => setForm({ ...form, task: e.target.value })}
                required
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Agent *</Label>
              <Select
                value={form.agentId || leadAgent?.id || ""}
                onValueChange={(v) => setForm({ ...form, agentId: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.isLead ? " (Lead)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Task Type</Label>
                <Input
                  placeholder="e.g. code, research"
                  value={form.taskType}
                  onChange={(e) => setForm({ ...form, taskType: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Priority (0–100)</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Tags (comma-separated)</Label>
              <Input
                placeholder="feature, urgent"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Dependencies</Label>
              {form.dependsOn.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1">
                  {form.dependsOn.map((depId) => {
                    const depTask = availableDeps.find((t) => t.id === depId);
                    return (
                      <Badge
                        key={depId}
                        variant="outline"
                        className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center gap-1 cursor-pointer hover:bg-red-500/10 hover:border-red-500/30"
                        onClick={() =>
                          setForm({ ...form, dependsOn: form.dependsOn.filter((d) => d !== depId) })
                        }
                      >
                        #{depId.slice(0, 8)} {depTask ? `— ${depTask.task.slice(0, 20)}` : ""}
                        <X className="h-2.5 w-2.5" />
                      </Badge>
                    );
                  })}
                </div>
              )}
              <div className="space-y-1">
                <Input
                  placeholder="Search pending/running tasks..."
                  value={depSearch}
                  onChange={(e) => setDepSearch(e.target.value)}
                />
                {depSearch && filteredDeps.length > 0 && (
                  <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-popover">
                    {filteredDeps.slice(0, 10).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        disabled={form.dependsOn.includes(t.id)}
                        onClick={() => {
                          setForm({ ...form, dependsOn: [...form.dependsOn, t.id] });
                          setDepSearch("");
                        }}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <StatusBadge status={t.status} />
                        <span className="truncate flex-1">{t.task}</span>
                        <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                          #{t.id.slice(0, 8)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-primary hover:bg-primary/90"
              disabled={!form.task.trim() || !(form.agentId || leadAgent?.id)}
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const PAGE_SIZE = 100;

export default function TasksPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Read all filter state from URL params
  const statusFilter = searchParams.get("status") ?? "all";
  const agentFilter = searchParams.get("agent") ?? "all";
  const scheduleFilter = searchParams.get("schedule") ?? "all";
  const searchParam = searchParams.get("search") ?? "";
  const includeHeartbeat = searchParams.get("heartbeat") === "true";
  const page = searchParams.has("page") ? Number(searchParams.get("page")) : 0;

  // Single setter that updates one key while preserving others
  const setParam = useCallback(
    (key: string, value: string, resetPage = true) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        // Set or delete the key
        const defaultValues: Record<string, string> = {
          status: "all",
          agent: "all",
          schedule: "all",
          search: "",
          page: "0",
        };
        if (value === (defaultValues[key] ?? "")) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
        // Reset page when changing filters
        if (resetPage && key !== "page") next.delete("page");
        return next;
      });
    },
    [setSearchParams],
  );

  const { data: agents } = useAgents();
  const { data: schedules } = useScheduledTasks();
  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  const filters = useMemo(() => {
    const f: {
      status?: string;
      agentId?: string;
      scheduleId?: string;
      search?: string;
      includeHeartbeat?: boolean;
      limit: number;
      offset: number;
    } = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (statusFilter !== "all") f.status = statusFilter;
    if (agentFilter !== "all") f.agentId = agentFilter;
    if (scheduleFilter !== "all") f.scheduleId = scheduleFilter;
    if (searchParam) f.search = searchParam;
    if (includeHeartbeat) f.includeHeartbeat = true;
    return f;
  }, [statusFilter, agentFilter, scheduleFilter, searchParam, includeHeartbeat, page]);

  const { data: tasksData, isLoading } = useTasks(filters);
  const createTask = useCreateTask();
  const [dialogOpen, setDialogOpen] = useState(false);

  function handleCreateSubmit(data: TaskFormData) {
    const tags = data.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    createTask.mutate({
      task: data.task,
      agentId: data.agentId,
      ...(data.taskType && { taskType: data.taskType }),
      ...(tags.length > 0 && { tags }),
      ...(data.priority !== 50 && { priority: data.priority }),
      ...(data.dependsOn.length > 0 && { dependsOn: data.dependsOn }),
    });
  }

  const total = tasksData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasActiveFilters =
    statusFilter !== "all" ||
    agentFilter !== "all" ||
    scheduleFilter !== "all" ||
    searchParam !== "" ||
    includeHeartbeat ||
    page !== 0;

  const clearFilters = useCallback(() => {
    setSearchParams(new URLSearchParams());
  }, [setSearchParams]);

  const columnDefs = useMemo<ColDef<AgentTask>[]>(
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
        field: "source",
        headerName: "Source",
        width: 95,
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
        field: "priority",
        headerName: "Priority",
        width: 70,
        cellRenderer: (params: { value: number | undefined }) => {
          const v = params.value;
          if (!v) return null;
          const color =
            v >= 80 ? "text-amber-500" : v >= 60 ? "text-foreground" : "text-muted-foreground";
          return <span className={`text-xs font-medium ${color}`}>{v}</span>;
        },
      },
      {
        field: "model",
        headerName: "Model",
        width: 80,
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
        cellRenderer: (params: { value: string[] | undefined; data: AgentTask | undefined }) => {
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
        field: "tags",
        headerName: "Tags",
        width: 200,
        cellRenderer: (params: { value: string[] }) => (
          <div className="flex gap-1 items-center">
            {params.value?.slice(0, 2).map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase shrink-0"
              >
                {tag}
              </Badge>
            ))}
            {(params.value?.length ?? 0) > 2 && (
              <span className="text-[9px] text-muted-foreground font-medium shrink-0">
                +{(params.value?.length ?? 0) - 2}
              </span>
            )}
          </div>
        ),
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

  const onRowClicked = useCallback(
    (event: RowClickedEvent<AgentTask>) => {
      if (event.data) navigate(`/tasks/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <Button
          onClick={() => setDialogOpen(true)}
          size="sm"
          className="gap-1 bg-primary hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" /> Create Task
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            value={searchParam}
            onChange={(e) => setParam("search", e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setParam("status", v)}>
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
        <Select value={agentFilter} onValueChange={(v) => setParam("agent", v)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            {agents?.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
                {a.isLead ? " (Lead)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={scheduleFilter} onValueChange={(v) => setParam("schedule", v)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Schedule" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Schedules</SelectItem>
            {schedules?.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{s.name}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <Switch
            size="sm"
            checked={includeHeartbeat}
            onCheckedChange={(checked) => setParam("heartbeat", checked ? "true" : "")}
          />
          Heartbeat
        </label>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-xs text-muted-foreground"
            onClick={clearFilters}
          >
            <X className="h-3 w-3 mr-1" />
            Clear filters
          </Button>
        )}
      </div>

      <DataGrid
        rowData={tasksData?.tasks ?? []}
        columnDefs={columnDefs}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No tasks found"
        pagination={false}
      />

      {/* Server-side pagination controls */}
      <div className="flex items-center justify-between shrink-0 text-sm text-muted-foreground">
        <span>
          {total > 0
            ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`
            : "0 tasks"}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page === 0}
            onClick={() => setParam("page", String(page - 1), false)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-2 text-xs">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page >= totalPages - 1}
            onClick={() => setParam("page", String(page + 1), false)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <CreateTaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateSubmit}
      />
    </div>
  );
}
