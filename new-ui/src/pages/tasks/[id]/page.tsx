import { useParams, useNavigate, Link } from "react-router-dom";
import { useTask, useTaskSessionLogs } from "@/api/hooks/use-tasks";
import { useAgents } from "@/api/hooks/use-agents";
import { StatusBadge } from "@/components/shared/status-badge";
import { SessionLogViewer } from "@/components/shared/session-log-viewer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatSmartTime, formatRelativeTime } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import type { AgentLog } from "@/api/types";
import { useMemo } from "react";

function LogTimeline({ logs }: { logs: AgentLog[] }) {
  return (
    <div className="space-y-2">
      {logs.map((log) => (
        <div key={log.id} className="flex gap-3 text-sm">
          <div className="flex flex-col items-center">
            <div className="h-2 w-2 rounded-full bg-primary/60 mt-1.5" />
            <div className="flex-1 w-px bg-border/50" />
          </div>
          <div className="pb-3">
            <p className="font-medium">{log.eventType.replace(/_/g, " ")}</p>
            {log.newValue && (
              <p className="text-xs text-muted-foreground">{log.newValue}</p>
            )}
            <p className="text-xs text-muted-foreground">{formatRelativeTime(log.createdAt)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading } = useTask(id!);
  const { data: sessionLogs } = useTaskSessionLogs(id!);
  const { data: agents } = useAgents();

  const agentName = useMemo(() => {
    if (!task?.agentId || !agents) return null;
    return agents.find((a) => a.id === task.agentId)?.name ?? null;
  }, [task, agents]);

  if (isLoading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!task) {
    return <p className="text-muted-foreground">Task not found.</p>;
  }

  const hasSessionLogs = sessionLogs && sessionLogs.length > 0;
  const hasRightColumn = hasSessionLogs || task.output || task.failureReason;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <button
        type="button"
        onClick={() => navigate("/tasks")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Tasks
      </button>

      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={task.status} size="md" />
          {task.taskType && <Badge variant="outline">{task.taskType}</Badge>}
          {task.priority !== undefined && (
            <Badge variant="secondary" className="font-mono">
              P{task.priority}
            </Badge>
          )}
          {task.tags?.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          {task.agentId && (
            <span>
              Agent:{" "}
              <Link to={`/agents/${task.agentId}`} className="text-primary hover:underline">
                {agentName ?? task.agentId.slice(0, 8) + "..."}
              </Link>
            </span>
          )}
          <span>Created {formatSmartTime(task.createdAt)}</span>
          {task.finishedAt && <span>Finished {formatSmartTime(task.finishedAt)}</span>}
        </div>
      </div>

      {/* Two-column layout */}
      <div className={hasRightColumn ? "grid gap-4 md:grid-cols-[1fr_1.5fr]" : ""}>
        {/* Left column: Description + Progress + Event History */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">{task.task}</pre>
            </CardContent>
          </Card>

          {task.progress && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Progress</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed max-h-48 overflow-auto">
                  {task.progress}
                </pre>
              </CardContent>
            </Card>
          )}

          {task.logs && task.logs.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Event History</CardTitle>
              </CardHeader>
              <CardContent>
                <LogTimeline logs={task.logs} />
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column: Output / Error + Session Logs */}
        {hasRightColumn && (
          <div className="space-y-4">
            {task.output && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground">Output</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed max-h-48 overflow-auto">
                    {task.output}
                  </pre>
                </CardContent>
              </Card>
            )}

            {task.failureReason && (
              <Card className="border-red-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-red-400">Failure Reason</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed text-red-300">
                    {task.failureReason}
                  </pre>
                </CardContent>
              </Card>
            )}

            {hasSessionLogs && (
              <SessionLogViewer logs={sessionLogs} className="h-[500px]" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
