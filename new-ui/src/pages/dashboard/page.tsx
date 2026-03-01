import { useMemo } from "react";
import { Link } from "react-router-dom";
import { StatsBar } from "@/components/shared/stats-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { useStats, useHealth, useLogs } from "@/api/hooks/use-stats";
import { useAgents } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import { useDashboardCosts } from "@/api/hooks/use-costs";
import { formatRelativeTime, cn } from "@/lib/utils";
import {
  Users,
  ListTodo,
  Activity,
  Crown,
  UserPlus,
  UserMinus,
  ClipboardPlus,
  ArrowRightLeft,
  CircleCheck,
  CircleX,
  Ban,
  MessageSquare,
  Radio,
  Server,
  Timer,
  Loader2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentWithTasks, AgentLog } from "@/api/types";

// --- Agent Tile (Command Center style) ---

function AgentRow({ agent, currentTaskText }: { agent: AgentWithTasks; currentTaskText?: string }) {
  return (
    <Link
      to={`/agents/${agent.id}`}
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0"
    >
      <div className="shrink-0">
        {agent.status === "busy" ? (
          <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
        ) : (
          <div
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              agent.status === "idle" && "bg-emerald-500",
              agent.status === "offline" && "bg-zinc-500",
            )}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold truncate">{agent.name}</span>
          {agent.isLead && <Crown className="h-3 w-3 text-primary shrink-0" />}
        </div>
        {currentTaskText && (
          <p className="text-[11px] text-muted-foreground/80 truncate">{currentTaskText}</p>
        )}
      </div>
      <StatusBadge status={agent.status} />
    </Link>
  );
}

// --- Active Task Row (Vercel deployments style) ---

function ActiveTaskRow({
  task,
  agentName,
}: {
  task: { id: string; task: string; status: string; agentId: string | null; createdAt: string; progress?: string };
  agentName: string | null;
}) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0"
    >
      {task.status === "in_progress" || task.status === "offered" ? (
        <Loader2 className="h-3 w-3 animate-spin text-amber-500 shrink-0" />
      ) : (
        <div
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            task.status === "pending" && "bg-yellow-500",
          )}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{task.task}</p>
        <p className="text-[11px] text-muted-foreground">
          {agentName ?? (task.agentId ? task.agentId.slice(0, 8) + "..." : "Unassigned")}
        </p>
      </div>
      <span className="text-[11px] text-muted-foreground shrink-0">
        {formatRelativeTime(task.createdAt)}
      </span>
    </Link>
  );
}

// --- Activity Feed (Linear-style with icons) ---

const eventIcons: Record<string, { icon: LucideIcon; color: string }> = {
  agent_joined: { icon: UserPlus, color: "text-emerald-400 bg-emerald-400/10" },
  agent_left: { icon: UserMinus, color: "text-zinc-400 bg-zinc-400/10" },
  agent_status_change: { icon: Radio, color: "text-yellow-400 bg-yellow-400/10" },
  task_created: { icon: ClipboardPlus, color: "text-blue-400 bg-blue-400/10" },
  task_status_change: { icon: ArrowRightLeft, color: "text-primary bg-primary/10" },
  task_progress: { icon: Timer, color: "text-amber-400 bg-amber-400/10" },
  task_offered: { icon: ArrowRightLeft, color: "text-amber-400 bg-amber-400/10" },
  task_accepted: { icon: CircleCheck, color: "text-emerald-400 bg-emerald-400/10" },
  task_rejected: { icon: CircleX, color: "text-red-400 bg-red-400/10" },
  task_claimed: { icon: CircleCheck, color: "text-emerald-400 bg-emerald-400/10" },
  task_released: { icon: Ban, color: "text-zinc-400 bg-zinc-400/10" },
  channel_message: { icon: MessageSquare, color: "text-blue-300 bg-blue-300/10" },
  service_registered: { icon: Server, color: "text-purple-400 bg-purple-400/10" },
};

function statusColor(status: string | null | undefined): string {
  switch (status) {
    case "completed": return "text-emerald-400";
    case "failed": case "cancelled": return "text-red-400";
    case "in_progress": case "busy": return "text-amber-400";
    case "idle": return "text-emerald-400";
    case "offline": return "text-zinc-400";
    default: return "text-primary";
  }
}

function ActivityItem({
  log,
  agentMap,
}: {
  log: AgentLog;
  agentMap: Map<string, string>;
}) {
  const config = eventIcons[log.eventType] ?? {
    icon: Activity,
    color: "text-zinc-400 bg-zinc-400/10",
  };
  const Icon = config.icon;

  const agentName = log.agentId ? agentMap.get(log.agentId) ?? log.agentId.slice(0, 8) : null;

  const agentLink = log.agentId ? (
    <Link to={`/agents/${log.agentId}`} className="font-semibold text-primary hover:underline">
      {agentName}
    </Link>
  ) : null;

  const taskLink = log.taskId ? (
    <Link
      to={`/tasks/${log.taskId}`}
      className="font-mono text-[11px] text-primary/80 bg-primary/10 px-1 py-0.5 rounded hover:underline"
    >
      #{log.taskId.slice(0, 8)}
    </Link>
  ) : null;

  const renderContent = () => {
    switch (log.eventType) {
      case "agent_joined":
        return <>{agentLink} joined the swarm</>;
      case "agent_left":
        return <>{agentLink} left the swarm</>;
      case "agent_status_change":
        return (
          <>
            {agentLink} is now{" "}
            <span className={cn("font-semibold", statusColor(log.newValue))}>
              {log.newValue}
            </span>
          </>
        );
      case "task_created":
        return (
          <>
            New task {taskLink} created
            {log.newValue && (
              <span className="block mt-0.5 text-[11px] text-muted-foreground/80 italic border-l-2 border-muted-foreground/20 pl-2 line-clamp-1">
                {log.newValue}
              </span>
            )}
          </>
        );
      case "task_status_change":
        return (
          <>
            Task {taskLink}{" "}
            {log.oldValue && (
              <span className={cn("font-medium", statusColor(log.oldValue))}>{log.oldValue}</span>
            )}
            {log.oldValue && " → "}
            <span className={cn("font-semibold", statusColor(log.newValue))}>{log.newValue}</span>
          </>
        );
      case "task_progress":
        return (
          <>
            {taskLink}
            {log.newValue && (
              <span className="block mt-0.5 text-[11px] text-muted-foreground/80 italic border-l-2 border-muted-foreground/20 pl-2 line-clamp-1">
                {log.newValue}
              </span>
            )}
          </>
        );
      case "task_offered":
        return <>{agentLink} was offered task {taskLink}</>;
      case "task_accepted":
        return <>{agentLink} accepted task {taskLink}</>;
      case "task_rejected":
        return <>{agentLink} rejected task {taskLink}</>;
      case "task_claimed":
        return <>{agentLink} claimed task {taskLink}</>;
      case "task_released":
        return <>{agentLink} released task {taskLink}</>;
      case "channel_message": {
        let channelId: string | undefined;
        if (log.metadata) {
          try { channelId = JSON.parse(log.metadata).channelId; } catch { /* ignore */ }
        }
        return (
          <>
            {agentLink ?? <span className="font-semibold text-muted-foreground">Human</span>}{" "}
            in{" "}
            {channelId ? (
              <Link to={`/chat?channel=${channelId}`} className="font-semibold text-blue-400 hover:underline">
                #chat
              </Link>
            ) : (
              <span className="font-semibold text-blue-400">#chat</span>
            )}
          </>
        );
      }
      default:
        return <span className="font-medium">{String(log.eventType).replace(/_/g, " ")}</span>;
    }
  };

  return (
    <div className="flex items-start gap-3 py-2">
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full mt-0.5",
          config.color,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm">{renderContent()}</p>
        <p className="text-[11px] text-muted-foreground">
          {formatRelativeTime(log.createdAt)}
        </p>
      </div>
    </div>
  );
}

// --- Dashboard Page ---

export default function DashboardPage() {
  const { data: stats } = useStats();
  const { data: health, isError: healthError } = useHealth();
  const { data: agents } = useAgents();
  const { data: tasksData } = useTasks({ status: "in_progress" });
  const { data: logs } = useLogs(15);
  const { data: dashboardCosts } = useDashboardCosts();

  const isHealthy = !!health && !healthError;

  const costToday = dashboardCosts?.costToday ?? 0;
  const costMtd = dashboardCosts?.costMtd ?? 0;

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  // Map agentId → current task text from active tasks
  const agentTaskMap = useMemo(() => {
    const m = new Map<string, string>();
    tasksData?.tasks.forEach((t) => {
      if (t.agentId && t.status === "in_progress") {
        m.set(t.agentId, t.task);
      }
    });
    return m;
  }, [tasksData]);

  // Sort agents: lead first, then busy, then idle, then offline
  const sortedAgents = useMemo(() => {
    if (!agents) return [];
    return [...agents].sort((a, b) => {
      const statusOrder = { busy: 0, idle: 1, offline: 2 };
      if (a.isLead !== b.isLead) return b.isLead ? 1 : -1;
      return (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
    });
  }, [agents]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto md:overflow-hidden gap-3 md:gap-4">
      {/* Stats Strip */}
      <div className="shrink-0">
        <StatsBar
          agents={stats?.agents}
          tasks={stats?.tasks}
          healthy={isHealthy}
          costToday={costToday}
          costMtd={costMtd}
        />
      </div>

      {/* Agent Grid + Active Tasks */}
      <div className="grid gap-3 md:gap-4 md:grid-cols-2 md:shrink-0">
        {/* Agent Status Grid */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Agents</h2>
            {agents && (
              <span className="text-xs text-muted-foreground">{agents.length} total</span>
            )}
          </div>
          <div className="rounded-lg border border-border">
            {sortedAgents.length > 0 ? (
              <div>
                {sortedAgents.slice(0, 3).map((agent) => (
                  <AgentRow key={agent.id} agent={agent} currentTaskText={agentTaskMap.get(agent.id)} />
                ))}
                {sortedAgents.length > 3 && (
                  <Link to="/agents" className="block text-center text-xs text-primary hover:underline py-2.5 border-t border-border/30">
                    View all {sortedAgents.length} agents
                  </Link>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                No agents connected
              </div>
            )}
          </div>
        </div>

        {/* Active Tasks Panel */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Active Tasks</h2>
            {tasksData && (
              <span className="text-xs text-muted-foreground">
                {tasksData.tasks.length} running
              </span>
            )}
          </div>
          <div className="rounded-lg border border-border">
            {tasksData && tasksData.tasks.length > 0 ? (
              <div>
                {tasksData.tasks.slice(0, 3).map((task) => (
                  <ActiveTaskRow
                    key={task.id}
                    task={task}
                    agentName={task.agentId ? agentMap.get(task.agentId) ?? null : null}
                  />
                ))}
                {tasksData.tasks.length > 3 && (
                  <Link to="/tasks?status=in_progress" className="block text-center text-xs text-primary hover:underline py-2.5 border-t border-border/30">
                    View all {tasksData.tasks.length} active tasks
                  </Link>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                All quiet — no active tasks
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Activity Feed — fills remaining height, scrollable */}
      <div className="flex flex-col flex-1 min-h-0 gap-2">
        <div className="flex items-center gap-2 shrink-0">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Activity</h2>
        </div>
        <div className="rounded-lg border border-border flex-1 min-h-0 overflow-y-auto">
          {logs && logs.length > 0 ? (
            <div className="divide-y divide-border/50 px-3">
              {logs.map((log) => (
                <ActivityItem key={log.id} log={log} agentMap={agentMap} />
              ))}
              <div className="py-3 text-center">
                <Link to="/tasks" className="text-xs text-primary hover:underline">
                  View all activity
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              No recent activity
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
