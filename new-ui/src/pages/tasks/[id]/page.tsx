import { useParams, useNavigate, Link } from "react-router-dom";
import { useTask, useTaskSessionLogs } from "@/api/hooks/use-tasks";
import { useAgents } from "@/api/hooks/use-agents";
import { StatusBadge } from "@/components/shared/status-badge";
import { SessionLogViewer } from "@/components/shared/session-log-viewer";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { formatSmartTime, formatRelativeTime } from "@/lib/utils";
import {
  ArrowLeft,
  User,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Terminal,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { AgentLog } from "@/api/types";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

function logStatusColor(status: string | null | undefined): string {
  switch (status) {
    case "completed": return "text-emerald-400";
    case "failed": case "cancelled": return "text-red-400";
    case "in_progress": case "busy": return "text-amber-400";
    case "idle": return "text-emerald-400";
    case "offline": return "text-zinc-400";
    case "pending": case "offered": case "unassigned": return "text-yellow-400";
    default: return "text-primary";
  }
}

function logDotColor(eventType: string, newValue?: string): string {
  if (eventType === "task_status_change") {
    switch (newValue) {
      case "completed": return "bg-emerald-500";
      case "failed": case "cancelled": return "bg-red-500";
      case "in_progress": return "bg-amber-500";
      default: return "bg-primary/60";
    }
  }
  if (eventType === "task_created") return "bg-blue-400";
  if (eventType === "task_progress") return "bg-muted-foreground/40";
  return "bg-primary/60";
}

function renderLogContent(log: AgentLog): React.ReactNode {
  switch (log.eventType) {
    case "task_created":
      return <span className="text-xs font-medium">Task created</span>;
    case "task_status_change":
      return (
        <span className="text-xs">
          {log.oldValue && (
            <span className={cn("font-medium", logStatusColor(log.oldValue))}>{log.oldValue}</span>
          )}
          {log.oldValue && <span className="text-muted-foreground"> → </span>}
          <span className={cn("font-semibold", logStatusColor(log.newValue))}>{log.newValue}</span>
        </span>
      );
    case "task_progress":
      return (
        <p className="text-xs text-muted-foreground italic line-clamp-2">
          {log.newValue ?? "Progress update"}
        </p>
      );
    case "task_offered":
      return <span className="text-xs font-medium">Offered to agent</span>;
    case "task_accepted":
      return <span className="text-xs font-medium text-emerald-400">Accepted</span>;
    case "task_rejected":
      return <span className="text-xs font-medium text-red-400">Rejected</span>;
    case "task_claimed":
      return <span className="text-xs font-medium text-emerald-400">Claimed</span>;
    case "task_released":
      return <span className="text-xs font-medium">Released</span>;
    default:
      return (
        <>
          <span className="text-xs font-medium">{log.eventType.replace(/_/g, " ")}</span>
          {log.newValue && (
            <p className="text-xs text-muted-foreground truncate">{log.newValue}</p>
          )}
        </>
      );
  }
}

function LogTimeline({ logs }: { logs: AgentLog[] }) {
  return (
    <div className="space-y-0">
      {logs.map((log, i) => (
        <div key={log.id} className="flex gap-3 text-sm">
          <div className="flex flex-col items-center">
            <div className={cn("h-2 w-2 rounded-full mt-1.5 shrink-0", logDotColor(log.eventType, log.newValue ?? undefined))} />
            {i < logs.length - 1 && <div className="flex-1 w-px bg-border/40" />}
          </div>
          <div className="pb-3 min-w-0">
            {renderLogContent(log)}
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">{formatRelativeTime(log.createdAt)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function MetaRow({ icon: Icon, label, children }: { icon: React.ElementType; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="flex items-center gap-2 w-24 shrink-0">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="text-sm min-w-0">{children}</div>
    </div>
  );
}

function CollapsibleCard({
  title,
  icon: Icon,
  iconColor,
  borderColor,
  bgColor,
  children,
  defaultOpen = false,
}: {
  title: string;
  icon: React.ElementType;
  iconColor: string;
  borderColor: string;
  bgColor: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn("rounded-md border shrink-0", borderColor, bgColor)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className={cn("h-3 w-3 shrink-0", iconColor)} />
        ) : (
          <ChevronRight className={cn("h-3 w-3 shrink-0", iconColor)} />
        )}
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
        <span className={cn("text-xs font-semibold", iconColor)}>{title}</span>
      </button>
      {open && (
        <div className="px-3 pb-2.5">
          {children}
        </div>
      )}
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
      <div className="flex-1 min-h-0 space-y-4 p-1">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!task) {
    return <p className="text-muted-foreground">Task not found.</p>;
  }

  const isFailed = task.status === "failed";
  const isCompleted = task.status === "completed";
  const hasSessionLogs = sessionLogs && sessionLogs.length > 0;
  const hasOutput = !!task.output;
  const hasEvents = task.logs && task.logs.length > 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Breadcrumb — fixed */}
      <div className="px-1 pb-2 shrink-0">
        <button
          type="button"
          onClick={() => navigate("/tasks")}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Tasks
        </button>
      </div>

      {/* Header — fixed */}
      <div className="space-y-2 px-1 pb-3 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={task.status} size="md" />
          {task.taskType && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase">
              {task.taskType}
            </Badge>
          )}
          {task.priority !== undefined && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-mono leading-none items-center">
              P{task.priority}
            </Badge>
          )}
          {task.tags?.map((tag) => (
            <Badge key={tag} variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase">
              {tag}
            </Badge>
          ))}
        </div>
        <p className="text-sm leading-relaxed line-clamp-3">{task.task}</p>
      </div>

      <Separator className="shrink-0" />

      {/* Two-column layout — fills remaining height */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar: metadata */}
        <div className="md:w-52 lg:w-60 shrink-0 md:border-r border-border py-3 px-1 md:pr-3 space-y-1 overflow-y-auto min-h-0">
          {task.agentId && (
            <MetaRow icon={User} label="Agent">
              <Link to={`/agents/${task.agentId}`} className="text-primary hover:underline text-xs">
                {agentName ?? task.agentId.slice(0, 8) + "..."}
              </Link>
            </MetaRow>
          )}
          <MetaRow icon={Calendar} label="Created">
            <span className="text-xs">{formatSmartTime(task.createdAt)}</span>
          </MetaRow>
          {task.finishedAt && (
            <MetaRow icon={Clock} label="Finished">
              <span className="text-xs">{formatSmartTime(task.finishedAt)}</span>
            </MetaRow>
          )}

          {task.progress && (
            <>
              <Separator className="my-2" />
              <div className="space-y-1">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Progress</span>
                <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-32 overflow-auto">
                  {task.progress}
                </p>
              </div>
            </>
          )}

          {hasEvents && (
            <>
              <Separator className="my-2" />
              <div className="space-y-2">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Activity</span>
                <LogTimeline logs={task.logs!} />
              </div>
            </>
          )}
        </div>

        {/* Right content: output/error (collapsible) + session logs (fills remaining) */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden py-3 md:pl-3 px-1 gap-2">
          {/* Failure reason — collapsible, collapsed by default */}
          {isFailed && task.failureReason && (
            <CollapsibleCard
              title="Failure Reason"
              icon={AlertTriangle}
              iconColor="text-red-400"
              borderColor="border-red-500/30"
              bgColor="bg-red-500/5"
            >
              <pre className="whitespace-pre-wrap text-xs text-red-300/80 font-mono leading-relaxed max-h-48 overflow-auto">
                {task.failureReason}
              </pre>
            </CollapsibleCard>
          )}

          {/* Output — collapsible, collapsed by default */}
          {hasOutput && (
            <CollapsibleCard
              title="Output"
              icon={isCompleted ? CheckCircle2 : Terminal}
              iconColor={isCompleted ? "text-emerald-400" : "text-muted-foreground"}
              borderColor={isCompleted ? "border-emerald-500/30" : "border-border"}
              bgColor={isCompleted ? "bg-emerald-500/5" : "bg-muted/20"}
            >
              <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed max-h-48 overflow-auto text-foreground/80">
                {task.output}
              </pre>
            </CollapsibleCard>
          )}

          {/* Session logs — fills all remaining space */}
          {hasSessionLogs ? (
            <SessionLogViewer logs={sessionLogs} className="flex-1 min-h-0" />
          ) : (
            <div className="flex-1 flex items-center justify-center min-h-0">
              <div className="text-center text-muted-foreground">
                <Terminal className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-xs">No session data available</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
