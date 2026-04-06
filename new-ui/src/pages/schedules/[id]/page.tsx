import type { ColDef, RowClickedEvent } from "ag-grid-community";
import cronstrue from "cronstrue";
import { ArrowLeft, Clock, ListTodo, Pencil, Play, Timer, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import {
  useDeleteSchedule,
  useRunScheduleNow,
  useScheduledTask,
  useUpdateSchedule,
} from "@/api/hooks/use-schedules";
import { useTasks } from "@/api/hooks/use-tasks";
import type { AgentTask, AgentTaskStatus } from "@/api/types";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatElapsed, formatSmartTime, formatUTCTime } from "@/lib/utils";

function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: true });
  } catch {
    return expr;
  }
}

function formatInterval(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  return `${hours / 24}d`;
}

function ScheduleTasks({ scheduleId }: { scheduleId: string }) {
  const navigate = useNavigate();
  const { data: agents } = useAgents();
  const { data: tasksData, isLoading } = useTasks({ scheduleId, limit: 100 });

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

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
    <DataGrid
      rowData={tasksData?.tasks ?? []}
      columnDefs={columnDefs}
      onRowClicked={onRowClicked}
      loading={isLoading}
      emptyMessage="No tasks created by this schedule"
      domLayout="autoHeight"
    />
  );
}

export default function ScheduleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: schedule, isLoading } = useScheduledTask(id!);
  const { data: agents } = useAgents();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const runNow = useRunScheduleNow();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!schedule) {
    return <p className="text-muted-foreground">Schedule not found.</p>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <button
        type="button"
        onClick={() => navigate("/schedules")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Schedules
      </button>

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">{schedule.name}</h1>
        <div className="flex items-center gap-2">
          <Switch
            checked={schedule.enabled}
            onCheckedChange={(checked) =>
              updateSchedule.mutate({ id: schedule.id, data: { enabled: checked } })
            }
          />
          <span className="text-xs text-muted-foreground">
            {schedule.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <Badge
          variant="outline"
          className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${
            schedule.scheduleType === "one_time"
              ? "border-amber-500/30 text-amber-400"
              : "border-emerald-500/30 text-emerald-400"
          }`}
        >
          {schedule.scheduleType === "one_time" ? "One-time" : "Recurring"}
        </Badge>
        {schedule.taskType && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {schedule.taskType}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => runNow.mutate(schedule.id)}
            disabled={!schedule.enabled || runNow.isPending}
          >
            <Play className="h-3 w-3 mr-1" /> Run Now
          </Button>
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

      {schedule.description && (
        <p className="text-sm text-muted-foreground">{schedule.description}</p>
      )}

      <Tabs defaultValue="schedule">
        <TabsList>
          <TabsTrigger value="schedule">
            <Clock className="h-3.5 w-3.5" />
            Schedule
          </TabsTrigger>
          <TabsTrigger value="tasks">
            <ListTodo className="h-3.5 w-3.5" />
            Tasks
          </TabsTrigger>
        </TabsList>

        <TabsContent value="schedule" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Schedule Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    {schedule.scheduleType === "one_time"
                      ? schedule.lastRunAt
                        ? "Executed At"
                        : "Runs At"
                      : schedule.cronExpression
                        ? "Cron Expression"
                        : "Interval"}
                  </span>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {schedule.scheduleType === "one_time" ? (
                      <>
                        <Timer className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">
                          {schedule.lastRunAt
                            ? formatUTCTime(schedule.lastRunAt)
                            : schedule.nextRunAt
                              ? formatUTCTime(schedule.nextRunAt)
                              : "—"}
                        </span>
                      </>
                    ) : schedule.cronExpression ? (
                      <>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <div className="space-y-0.5">
                          <code className="text-sm font-mono">{schedule.cronExpression}</code>
                          <p className="text-xs text-muted-foreground">
                            {describeCron(schedule.cronExpression)}
                            <span className="ml-1 opacity-60">({schedule.timezone || "UTC"})</span>
                          </p>
                        </div>
                      </>
                    ) : schedule.intervalMs ? (
                      <>
                        <Timer className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">Every {formatInterval(schedule.intervalMs)}</span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">Not set</span>
                    )}
                  </div>
                </div>

                {schedule.cronExpression && (
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      Timezone
                    </span>
                    <p className="text-sm">{schedule.timezone || "UTC"}</p>
                  </div>
                )}

                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Target Agent
                  </span>
                  <p className="text-sm">
                    {schedule.targetAgentId ? (
                      <Link
                        to={`/agents/${schedule.targetAgentId}`}
                        className="text-primary hover:underline"
                      >
                        {agentMap.get(schedule.targetAgentId) ??
                          `${schedule.targetAgentId.slice(0, 8)}...`}
                      </Link>
                    ) : (
                      "Task Pool"
                    )}
                  </p>
                </div>

                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Priority
                  </span>
                  <p className="text-sm font-mono">{schedule.priority}</p>
                </div>

                {schedule.tags.length > 0 && (
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      Tags
                    </span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {schedule.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Timing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Next Run
                  </span>
                  {schedule.nextRunAt ? (
                    <div>
                      <p className="text-sm">{formatSmartTime(schedule.nextRunAt)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatUTCTime(schedule.nextRunAt)}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm">—</p>
                  )}
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Last Run
                  </span>
                  {schedule.lastRunAt ? (
                    <div>
                      <p className="text-sm">{formatSmartTime(schedule.lastRunAt)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatUTCTime(schedule.lastRunAt)}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm">Never</p>
                  )}
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Created
                  </span>
                  <p className="text-sm">{formatSmartTime(schedule.createdAt)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Last Updated
                  </span>
                  <p className="text-sm">{formatSmartTime(schedule.lastUpdatedAt)}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Task Template</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed rounded-md bg-muted p-3 text-muted-foreground">
                {schedule.taskTemplate}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tasks">{id && <ScheduleTasks scheduleId={id} />}</TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      {editOpen && (
        <EditScheduleDialog
          schedule={schedule}
          agents={agents}
          open={editOpen}
          onOpenChange={setEditOpen}
          onSubmit={(data) => {
            updateSchedule.mutate({ id: schedule.id, data });
            setEditOpen(false);
          }}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Schedule</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{schedule.name}</strong>? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                deleteSchedule.mutate(schedule.id, { onSuccess: () => navigate("/schedules") });
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

function EditScheduleDialog({
  schedule,
  agents,
  open,
  onOpenChange,
  onSubmit,
}: {
  schedule: {
    name: string;
    taskTemplate: string;
    cronExpression?: string;
    intervalMs?: number;
    description?: string;
    taskType?: string;
    tags: string[];
    priority: number;
    targetAgentId?: string;
    timezone: string;
    model?: string;
  };
  agents: { id: string; name: string; isLead?: boolean }[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(schedule.name);
  const [taskTemplate, setTaskTemplate] = useState(schedule.taskTemplate);
  const [cronExpression, setCronExpression] = useState(schedule.cronExpression ?? "");
  const [intervalMinutes, setIntervalMinutes] = useState(
    schedule.intervalMs ? schedule.intervalMs / 60000 : 60,
  );
  const [scheduleType, setScheduleType] = useState<"cron" | "interval">(
    schedule.cronExpression ? "cron" : "interval",
  );
  const [description, setDescription] = useState(schedule.description ?? "");
  const [taskType, setTaskType] = useState(schedule.taskType ?? "");
  const [tags, setTags] = useState(schedule.tags.join(", "));
  const [priority, setPriority] = useState(schedule.priority);
  const [targetAgentId, setTargetAgentId] = useState(schedule.targetAgentId ?? "");
  const [timezone, setTimezone] = useState(schedule.timezone);
  const [model, setModel] = useState(schedule.model ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    onSubmit({
      name,
      taskTemplate,
      ...(scheduleType === "cron"
        ? { cronExpression, intervalMs: null }
        : { intervalMs: intervalMinutes * 60000, cronExpression: null }),
      description: description || null,
      taskType: taskType || null,
      tags: tagList,
      priority,
      targetAgentId: targetAgentId || null,
      timezone,
      model: model || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Schedule</DialogTitle>
            <DialogDescription>Update schedule configuration.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Task Template *</Label>
              <Textarea
                value={taskTemplate}
                onChange={(e) => setTaskTemplate(e.target.value)}
                required
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Schedule Type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={scheduleType === "cron" ? "default" : "outline"}
                  onClick={() => setScheduleType("cron")}
                >
                  Cron
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={scheduleType === "interval" ? "default" : "outline"}
                  onClick={() => setScheduleType("interval")}
                >
                  Interval
                </Button>
              </div>
            </div>
            {scheduleType === "cron" ? (
              <div className="space-y-2">
                <Label>Cron Expression *</Label>
                <Input
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  className="font-mono"
                  required
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Interval (minutes)</Label>
                <Input
                  type="number"
                  min={1}
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Target Agent</Label>
                <Select
                  value={targetAgentId}
                  onValueChange={(v) => setTargetAgentId(v === "_none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Task Pool" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">Task Pool</SelectItem>
                    {agents?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        {a.isLead ? " (Lead)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Task Type</Label>
                <Input value={taskType} onChange={(e) => setTaskType(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Model</Label>
                <Select value={model} onValueChange={(v) => setModel(v === "_none" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">Default</SelectItem>
                    <SelectItem value="haiku">Haiku</SelectItem>
                    <SelectItem value="sonnet">Sonnet</SelectItem>
                    <SelectItem value="opus">Opus</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Tags (comma-separated)</Label>
                <Input value={tags} onChange={(e) => setTags(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-primary hover:bg-primary/90"
              disabled={!name.trim() || !taskTemplate.trim()}
            >
              Update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
