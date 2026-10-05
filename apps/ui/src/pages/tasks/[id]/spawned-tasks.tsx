import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { AgentTask } from "@/api/types";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { statusLabel } from "@/lib/status-labels";
import { isAutoReview } from "@/lib/task-links";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatRelativeTime } from "@/lib/utils";
import { NARROW_TARGET } from "./touch-targets";

/** The tasks `parentId` started directly, oldest first, without auto-review follow-ups. */
export function directChildren(parentId: string, chain: readonly AgentTask[]): AgentTask[] {
  return chain
    .filter((task) => task.parentTaskId === parentId && !isAutoReview(task))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The tasks this task started (delegations, follow-ups, retries), each a link
 * to its page. Renders nothing when there are none.
 */
export function SpawnedTasks({
  tasks,
  agentNameFor,
}: {
  tasks: AgentTask[];
  agentNameFor: (agentId: string) => string | null;
}) {
  if (tasks.length === 0) return null;
  return (
    <section aria-labelledby="spawned-tasks-heading" className="flex flex-col gap-1.5">
      <h2
        id="spawned-tasks-heading"
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
      >
        Spawned tasks
        <span className="font-mono tabular-nums">{tasks.length}</span>
      </h2>
      <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border">
        {tasks.map((child) => {
          const agent = child.agentId
            ? (agentNameFor(child.agentId) ?? `${child.agentId.slice(0, 8)}…`)
            : "Unassigned";
          return (
            <li key={child.id}>
              <Link
                to={`/tasks/${child.id}`}
                className={cn(
                  "hover-linger flex min-w-0 items-center gap-3 px-3 py-2 text-sm outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
                  NARROW_TARGET,
                )}
              >
                <TaskStatusIcon status={child.status} label={statusLabel(child.status)} />
                <span className="shrink-0 font-mono text-xs text-primary">
                  #{child.id.slice(0, 8)}
                </span>
                <span className="min-w-0 flex-1 truncate">{taskListTitle(child)}</span>
                <span className="hidden shrink-0 text-xs text-muted-foreground @min-[40rem]:inline">
                  {agent}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {formatRelativeTime(child.createdAt)}
                </span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
