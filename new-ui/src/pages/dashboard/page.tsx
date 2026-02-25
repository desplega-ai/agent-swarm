import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatsBar } from "@/components/shared/stats-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { useStats, useHealth, useLogs } from "@/api/hooks/use-stats";
import { useAgents } from "@/api/hooks/use-agents";
import { useTasks } from "@/api/hooks/use-tasks";
import { formatRelativeTime } from "@/lib/utils";
import { Users, ListTodo, Activity } from "lucide-react";
import type { AgentWithTasks, AgentLog } from "@/api/types";

function AgentCard({ agent }: { agent: AgentWithTasks }) {
  const currentTask = agent.tasks?.find((t) => t.status === "in_progress");

  return (
    <Card className="border-border/50 hover:border-border transition-colors">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-semibold truncate">{agent.name}</p>
            {agent.role && (
              <p className="text-xs text-muted-foreground truncate">{agent.role}</p>
            )}
          </div>
          <StatusBadge status={agent.status} />
        </div>
        {currentTask && (
          <p className="mt-2 text-xs text-muted-foreground line-clamp-2">
            {currentTask.task}
          </p>
        )}
        {agent.capabilities && agent.capabilities.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {agent.capabilities.slice(0, 4).map((cap) => (
              <span
                key={cap}
                className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {cap}
              </span>
            ))}
            {agent.capabilities.length > 4 && (
              <span className="text-[10px] text-muted-foreground">
                +{agent.capabilities.length - 4}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const eventColors: Record<string, string> = {
  agent_joined: "text-emerald-400",
  agent_left: "text-zinc-400",
  task_created: "text-blue-400",
  task_status_change: "text-primary",
  task_completed: "text-emerald-400",
  task_failed: "text-red-400",
  task_cancelled: "text-zinc-400",
  message_posted: "text-blue-300",
  agent_status_change: "text-yellow-400",
  service_registered: "text-purple-400",
  schedule_triggered: "text-cyan-400",
};

function ActivityItem({ log }: { log: AgentLog }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <div
        className={`mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0 ${eventColors[log.eventType] ?? "text-zinc-400"}`}
        style={{ backgroundColor: "currentColor" }}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">
          <span className="font-medium">{log.eventType.replace(/_/g, " ")}</span>
          {log.metadata && (
            <span className="text-muted-foreground">
              {" "}&mdash; {typeof log.metadata === "string" ? log.metadata : ""}
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatRelativeTime(log.createdAt)}
        </p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: stats } = useStats();
  const { data: health, isError: healthError } = useHealth();
  const { data: agents } = useAgents();
  const { data: tasksData } = useTasks({ status: "in_progress" });
  const { data: logs } = useLogs(20);

  const isHealthy = !!health && !healthError;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      {/* Stats Bar */}
      <StatsBar
        agents={stats?.agents}
        tasks={stats?.tasks}
        epics={{ active: 0 }}
        healthy={isHealthy}
      />

      {/* Agent Overview + Active Tasks */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Agent Cards */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-muted-foreground" />
              Agents
              {agents && (
                <span className="ml-auto text-xs text-muted-foreground font-normal">
                  {agents.length} total
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {agents && agents.length > 0 ? (
              agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No agents connected
              </p>
            )}
          </CardContent>
        </Card>

        {/* Active Tasks */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ListTodo className="h-4 w-4 text-muted-foreground" />
              Active Tasks
              {tasksData && (
                <span className="ml-auto text-xs text-muted-foreground font-normal">
                  {tasksData.tasks.length} running
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {tasksData && tasksData.tasks.length > 0 ? (
              <div className="space-y-3">
                {tasksData.tasks.map((task) => (
                  <div key={task.id} className="flex items-start gap-2">
                    <StatusBadge status={task.status} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm line-clamp-2">{task.task}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.agentId ? `Agent: ${task.agentId.slice(0, 8)}...` : "Unassigned"}
                        {task.createdAt && ` \u00b7 ${formatRelativeTime(task.createdAt)}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No active tasks
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity Feed */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Activity Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          {logs && logs.length > 0 ? (
            <div className="divide-y divide-border/50">
              {logs.map((log) => (
                <ActivityItem key={log.id} log={log} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No recent activity
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
