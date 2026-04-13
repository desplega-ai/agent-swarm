import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import cronstrue from "cronstrue";
import { Clock, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useCreateSchedule, useScheduledTasks, useUpdateSchedule } from "@/api/hooks/use-schedules";
import type { ScheduledTask } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSmartTime, formatUTCTime } from "@/lib/utils";

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

interface ScheduleFormData {
  name: string;
  taskTemplate: string;
  scheduleType: "cron" | "interval";
  cronExpression: string;
  intervalMinutes: number;
  description: string;
  taskType: string;
  tags: string;
  priority: number;
  targetAgentId: string;
  timezone: string;
  model: string;
  enabled: boolean;
}

const emptyScheduleForm: ScheduleFormData = {
  name: "",
  taskTemplate: "",
  scheduleType: "cron",
  cronExpression: "",
  intervalMinutes: 60,
  description: "",
  taskType: "",
  tags: "",
  priority: 50,
  targetAgentId: "",
  timezone: "UTC",
  model: "",
  enabled: true,
};

function ScheduleDialog({
  open,
  onOpenChange,
  onSubmit,
  editData,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: ScheduleFormData) => void;
  editData?: ScheduleFormData | null;
}) {
  const { data: agents } = useAgents();
  const [form, setForm] = useState<ScheduleFormData>(editData ?? emptyScheduleForm);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(form);
    if (!editData) setForm(emptyScheduleForm);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{editData ? "Edit Schedule" : "Create Schedule"}</DialogTitle>
            <DialogDescription>
              {editData ? "Update schedule configuration." : "Set up a recurring task schedule."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                placeholder="Schedule name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Task Template *</Label>
              <Textarea
                placeholder="Task description template..."
                value={form.taskTemplate}
                onChange={(e) => setForm({ ...form, taskTemplate: e.target.value })}
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
                  variant={form.scheduleType === "cron" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, scheduleType: "cron" })}
                >
                  Cron
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.scheduleType === "interval" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, scheduleType: "interval" })}
                >
                  Interval
                </Button>
              </div>
            </div>
            {form.scheduleType === "cron" ? (
              <div className="space-y-2">
                <Label>Cron Expression *</Label>
                <Input
                  placeholder="0 * * * *"
                  value={form.cronExpression}
                  onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
                  className="font-mono"
                  required={form.scheduleType === "cron"}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Interval (minutes)</Label>
                <Input
                  type="number"
                  min={1}
                  value={form.intervalMinutes}
                  onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                placeholder="Optional description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Target Agent</Label>
                <Select
                  value={form.targetAgentId}
                  onValueChange={(v) => setForm({ ...form, targetAgentId: v === "_none" ? "" : v })}
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
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                />
              </div>
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
                <Label>Model</Label>
                <Select
                  value={form.model}
                  onValueChange={(v) => setForm({ ...form, model: v === "_none" ? "" : v })}
                >
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
                <Input
                  placeholder="UTC"
                  value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Tags (comma-separated)</Label>
                <Input
                  placeholder="daily, sync"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="schedule-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
              />
              <Label htmlFor="schedule-enabled">Enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-primary hover:bg-primary/90"
              disabled={!form.name.trim() || !form.taskTemplate.trim()}
            >
              {editData ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function SchedulesPage() {
  const navigate = useNavigate();
  const { data: schedules, isLoading } = useScheduledTasks();
  const { data: agents } = useAgents();
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const [dialogOpen, setDialogOpen] = useState(false);

  function handleCreateSubmit(data: ScheduleFormData) {
    const tags = data.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    createSchedule.mutate({
      name: data.name,
      taskTemplate: data.taskTemplate,
      ...(data.scheduleType === "cron"
        ? { cronExpression: data.cronExpression }
        : { intervalMs: data.intervalMinutes * 60 * 1000 }),
      ...(data.description && { description: data.description }),
      ...(data.taskType && { taskType: data.taskType }),
      ...(tags.length > 0 && { tags }),
      ...(data.priority !== 50 && { priority: data.priority }),
      ...(data.targetAgentId && { targetAgentId: data.targetAgentId }),
      ...(data.timezone !== "UTC" && { timezone: data.timezone }),
      ...(data.model && { model: data.model }),
      enabled: data.enabled,
    });
  }

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  const handleToggleEnabled = useCallback(
    (schedule: ScheduledTask, enabled: boolean) => {
      updateSchedule.mutate({ id: schedule.id, data: { enabled } });
    },
    [updateSchedule],
  );

  const columnDefs = useMemo<ColDef<ScheduledTask>[]>(
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
        field: "scheduleType",
        headerName: "Type",
        width: 110,
        cellRenderer: (params: { value?: string }) => (
          <Badge
            variant="outline"
            className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${
              params.value === "one_time"
                ? "border-amber-500/30 text-amber-400"
                : "border-emerald-500/30 text-emerald-400"
            }`}
          >
            {params.value === "one_time" ? "One-time" : "Recurring"}
          </Badge>
        ),
      },
      {
        headerName: "Schedule",
        width: 250,
        minWidth: 200,
        cellRenderer: (params: ICellRendererParams<ScheduledTask>) => {
          const data = params.data;
          if (!data) return null;

          if (data.scheduleType === "one_time") {
            const label = data.nextRunAt
              ? `at ${formatUTCTime(data.nextRunAt)}`
              : data.lastRunAt
                ? `ran ${formatUTCTime(data.lastRunAt)}`
                : "—";
            return <span className="font-mono text-xs text-muted-foreground">{label}</span>;
          }

          if (data.cronExpression) {
            const tz = data.timezone || "UTC";
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground cursor-default">
                    <span>{describeCron(data.cronExpression)}</span>
                    <span className="ml-1.5 text-[10px] opacity-60">({tz})</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <code>{data.cronExpression}</code>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (data.intervalMs) {
            return (
              <span className="font-mono text-xs text-muted-foreground">
                every {formatInterval(data.intervalMs)}
              </span>
            );
          }

          return <span className="text-xs text-muted-foreground">—</span>;
        },
      },
      {
        field: "targetAgentId",
        headerName: "Target Agent",
        width: 180,
        minWidth: 150,
        valueFormatter: (params) =>
          params.value ? (agentMap.get(params.value) ?? `${params.value.slice(0, 8)}...`) : "Pool",
      },
      {
        field: "nextRunAt",
        headerName: "Next Run",
        width: 160,
        cellRenderer: (params: ICellRendererParams<ScheduledTask>) => {
          if (!params.value) return <span className="text-muted-foreground">—</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default">{formatSmartTime(params.value)}</span>
              </TooltipTrigger>
              <TooltipContent>{formatUTCTime(params.value)}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        field: "lastRunAt",
        headerName: "Last Run",
        width: 160,
        cellRenderer: (params: ICellRendererParams<ScheduledTask>) => {
          if (!params.value) return <span className="text-muted-foreground">Never</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default">{formatSmartTime(params.value)}</span>
              </TooltipTrigger>
              <TooltipContent>{formatUTCTime(params.value)}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        field: "enabled",
        headerName: "Enabled",
        width: 100,
        cellRenderer: (params: ICellRendererParams<ScheduledTask>) => {
          const schedule = params.data;
          if (!schedule) return null;
          return (
            <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Switch
                size="sm"
                checked={schedule.enabled}
                onCheckedChange={(checked) => handleToggleEnabled(schedule, checked)}
              />
            </div>
          );
        },
      },
    ],
    [agentMap, handleToggleEnabled],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<ScheduledTask>) => {
      // Skip navigation when clicking interactive elements (switch, button, etc.)
      const target = event.event?.target as HTMLElement | null;
      if (target?.closest('[data-slot="switch"], button')) return;
      if (event.data) navigate(`/schedules/${event.data.id}`);
    },
    [navigate],
  );

  const createButton = (
    <Button
      onClick={() => setDialogOpen(true)}
      size="sm"
      className="gap-1 bg-primary hover:bg-primary/90"
    >
      <Plus className="h-3.5 w-3.5" /> Create Schedule
    </Button>
  );

  if (!isLoading && (!schedules || schedules.length === 0)) {
    return (
      <div className="flex flex-col flex-1 min-h-0 gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Schedules</h1>
          {createButton}
        </div>
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Clock className="h-8 w-8 mb-2" />
          <p className="text-sm">No scheduled tasks</p>
        </div>
        <ScheduleDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSubmit={handleCreateSubmit}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Schedules</h1>
        {createButton}
      </div>

      <DataGrid
        rowData={schedules ?? []}
        columnDefs={columnDefs}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No scheduled tasks"
      />

      <ScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateSubmit}
      />
    </div>
  );
}
