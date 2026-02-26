import { useMemo } from "react";
import { Link } from "react-router-dom";
import { StatsBar } from "@/components/shared/stats-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { useStats, useHealth, useLogs } from "@/api/hooks/use-stats";
import { useAgents } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentWithTasks, AgentLog } from "@/api/types";

// --- Agent Tile (Command Center style) ---

function AgentTile({ agent }: { agent: AgentWithTasks }) {
  const currentTask = agent.tasks?.find((t) => t.status === "in_progress");

  return (
    <Link
      to={`/agents/${agent.id}`}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50",
        agent.isLead ? "border-primary/30" : "border-border/50",
      )}
    >
      <div className="relative mt-0.5">
        <div
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            agent.status === "busy" && "bg-amber-500",
            agent.status === "idle" && "bg-emerald-500",
            agent.status === "offline" && "bg-zinc-500",
            agent.status === "busy" && "animate-pulse",
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold truncate">{agent.name}</span>
          {agent.isLead && <Crown className="h-3 w-3 text-primary shrink-0" />}
        </div>
        {agent.role && (
          <p className="text-[11px] text-muted-foreground truncate">{agent.role}</p>
        )}
        {currentTask && (
          <p className="mt-1 text-[11px] text-muted-foreground/80 line-clamp-1">
            {currentTask.task}
          </p>
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
      <div
        className={cn(
          "h-2 w-2 rounded-full shrink-0",
          task.status === "in_progress" && "bg-amber-500 animate-pulse",
          task.status === "pending" && "bg-yellow-500",
          task.status === "offered" && "bg-amber-500 animate-pulse",
        )}
      />
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

function ActivityItem({ log }: { log: AgentLog }) {
  const config = eventIcons[log.eventType] ?? {
    icon: Activity,
    color: "text-zinc-400 bg-zinc-400/10",
  };
  const Icon = config.icon;

  return (
    <div className="flex items-start gap-3 py-2">
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          config.color,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="font-medium">{log.eventType.replace(/_/g, " ")}</span>
          {log.metadata && (
            <span className="text-muted-foreground">
              {" "}&mdash; {typeof log.metadata === "string" ? log.metadata : ""}
            </span>
          )}
        </p>
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

  const isHealthy = !!health && !healthError;

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

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
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      {/* Stats Strip */}
      <StatsBar
        agents={stats?.agents}
        tasks={stats?.tasks}
        healthy={isHealthy}
      />

      {/* Agent Grid + Active Tasks */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Agent Status Grid */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Agents</h2>
            {agents && (
              <span className="text-xs text-muted-foreground">{agents.length} total</span>
            )}
          </div>
          {sortedAgents.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {sortedAgents.map((agent) => (
                <AgentTile key={agent.id} agent={agent} />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground rounded-lg border border-dashed border-border">
              No agents connected
            </div>
          )}
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
                {tasksData.tasks.map((task) => (
                  <ActiveTaskRow
                    key={task.id}
                    task={task}
                    agentName={task.agentId ? agentMap.get(task.agentId) ?? null : null}
                  />
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                All quiet — no active tasks
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Activity Feed */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Activity</h2>
          <Link to="/tasks" className="ml-auto text-xs text-primary hover:underline">
            View all
          </Link>
        </div>
        <div className="rounded-lg border border-border">
          {logs && logs.length > 0 ? (
            <div className="divide-y divide-border/50 px-3">
              {logs.map((log) => (
                <ActivityItem key={log.id} log={log} />
              ))}
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
