import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { AgentTask, AgentTaskStatus } from "@/api/types";
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
} from "@/components/kibo-ui/kanban";
import { StatusBadge } from "@/components/shared/status-badge";
import { taskListTitle } from "@/lib/task-title";
import { formatRelativeTime } from "@/lib/utils";

/** Board column order. Lifecycle order, left to right. */
const STATUS_ORDER: AgentTaskStatus[] = [
  "draft",
  "backlog",
  "unassigned",
  "offered",
  "reviewing",
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "superseded",
];

/** Always shown, even when empty, so the board keeps a stable shape. */
const CORE_STATUSES = new Set<AgentTaskStatus>(["pending", "in_progress", "completed", "failed"]);

interface TaskItem {
  [key: string]: unknown;
  id: string;
  name: string;
  column: string;
  task: AgentTask;
}

/**
 * Read-only Kanban view of a page of tasks, one column per status. Dragging is
 * disabled (no sensors): task status follows lifecycle rules, never a drop.
 */
export function TasksKanban({
  tasks,
  agentNameById,
  loading,
}: {
  tasks: AgentTask[];
  agentNameById: Map<string, string>;
  loading?: boolean;
}) {
  const items = useMemo<TaskItem[]>(
    () =>
      tasks.map((task) => ({
        id: task.id,
        name: taskListTitle(task),
        column: task.status,
        task,
      })),
    [tasks],
  );
  const columns = useMemo(() => {
    const present = new Set(tasks.map((t) => t.status));
    const known = STATUS_ORDER.filter((s) => CORE_STATUSES.has(s) || present.has(s));
    const unknown = [...present].filter((s) => !STATUS_ORDER.includes(s));
    return [...known, ...unknown].map((status) => ({ id: status, name: status }));
  }, [tasks]);

  if (loading && tasks.length === 0) {
    return <div className="flex-1 text-sm text-muted-foreground">Loading tasks…</div>;
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-testid="tasks-kanban">
      <KanbanProvider className="min-w-max items-start" columns={columns} data={items} sensors={[]}>
        {(column) => (
          <KanbanBoard className="w-72" id={column.id} key={column.id}>
            <KanbanHeader className="flex items-center justify-between">
              <StatusBadge status={column.id as AgentTaskStatus} />
              <span className="font-normal text-muted-foreground">
                {items.filter((item) => item.column === column.id).length}
              </span>
            </KanbanHeader>
            <KanbanCards<TaskItem> id={column.id}>
              {(item) => (
                <KanbanCard
                  className="cursor-default p-0"
                  column={item.column}
                  id={item.id}
                  key={item.id}
                  name={item.name}
                >
                  <Link
                    className="flex flex-col gap-1.5 p-3 hover:bg-muted/50"
                    to={`/tasks/${item.id}`}
                  >
                    <p className="m-0 line-clamp-3 font-medium text-sm">{item.name}</p>
                    <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
                      <span className="truncate">
                        {item.task.agentId
                          ? (agentNameById.get(item.task.agentId) ?? "Unknown agent")
                          : "Unassigned"}
                      </span>
                      <span className="shrink-0">{formatRelativeTime(item.task.createdAt)}</span>
                    </div>
                  </Link>
                </KanbanCard>
              )}
            </KanbanCards>
          </KanbanBoard>
        )}
      </KanbanProvider>
    </div>
  );
}
