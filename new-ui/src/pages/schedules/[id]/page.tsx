import type { ColDef, RowClickedEvent } from "ag-grid-community";
import { ArrowLeft, Clock, ListTodo, Timer } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useScheduledTasks } from "@/api/hooks/use-schedules";
import { useTasks } from "@/api/hooks/use-tasks";
import type { AgentTask, AgentTaskStatus } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

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
  const { data: schedules, isLoading } = useScheduledTasks();
  const { data: agents } = useAgents();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => {
      m.set(a.id, a.name);
    });
    return m;
  }, [agents]);

  const schedule = schedules?.find((s) => s.id === id);

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
        <Badge
          variant={schedule.enabled ? "default" : "secondary"}
          className={
            schedule.enabled ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : ""
          }
        >
          {schedule.enabled ? "Enabled" : "Disabled"}
        </Badge>
        {schedule.taskType && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {schedule.taskType}
          </Badge>
        )}
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
                    {schedule.cronExpression ? "Cron Expression" : "Interval"}
                  </span>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {schedule.cronExpression ? (
                      <>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <code className="text-sm font-mono">{schedule.cronExpression}</code>
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

                {schedule.timezone && (
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      Timezone
                    </span>
                    <p className="text-sm">{schedule.timezone}</p>
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
                  <p className="text-sm">
                    {schedule.nextRunAt ? formatSmartTime(schedule.nextRunAt) : "—"}
                  </p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Last Run
                  </span>
                  <p className="text-sm">
                    {schedule.lastRunAt ? formatSmartTime(schedule.lastRunAt) : "Never"}
                  </p>
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
    </div>
  );
}
