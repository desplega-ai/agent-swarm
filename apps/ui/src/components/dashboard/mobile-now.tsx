/**
 * Home below `md`: a stacked "Now" view instead of the activity timeline.
 *
 * At 390px the timeline's label column takes a third of the width and the
 * visible window rarely holds a task block, so the first screen was an empty
 * grid with no next action. This view answers the three questions an
 * operator opens the app with on a phone: what is waiting on me, what is
 * running, and what broke.
 */

import { ChevronRight, CircleCheck, Hourglass } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useApprovalRequests } from "@/api/hooks/use-approval-requests";
import { useTasks } from "@/api/hooks/use-tasks";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { StatusBadge } from "@/components/shared/status-badge";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatElapsed, formatRelativeTime, parseUTCDate } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

export function MobileNow() {
  const { data: approvals, isLoading: approvalsLoading } = useApprovalRequests({
    status: "pending",
  });
  const { data: running, isLoading: runningLoading } = useTasks({
    status: "in_progress",
    limit: 20,
    orderBy: "lastUpdatedAt",
  });
  const { data: queued } = useTasks({ status: "pending", limit: 1 });
  const { data: failed, isLoading: failedLoading } = useTasks({
    status: "failed",
    limit: 20,
    orderBy: "lastUpdatedAt",
  });
  const { data: agents } = useAgents();

  const agentName = useMemo(() => {
    const names = new Map((agents ?? []).map((a) => [a.id, a.name]));
    return (id: string | null) => (id ? (names.get(id) ?? "Unknown agent") : "Unassigned");
  }, [agents]);

  const recentFailures = useMemo(() => {
    const since = Date.now() - DAY_MS;
    return (failed?.tasks ?? []).filter(
      (t) => parseUTCDate(t.finishedAt ?? t.lastUpdatedAt).getTime() >= since,
    );
  }, [failed]);

  const waiting = approvals?.length ?? 0;
  const queuedCount = queued?.total ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <Link
        to="/approval-requests"
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-xl border px-4 py-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
          waiting > 0
            ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
            : "border-border bg-card hover:bg-accent/40",
        )}
      >
        {waiting > 0 ? (
          <Hourglass className="size-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <CircleCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">
            {approvalsLoading
              ? "Checking approvals…"
              : waiting > 0
                ? `${waiting} ${waiting === 1 ? "approval" : "approvals"} waiting on you`
                : "No approvals waiting"}
          </span>
          <span className="text-xs text-muted-foreground">
            {waiting > 0 ? "Answer them to unblock the agents" : "Agents are not blocked on you"}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>

      <NowSection
        title="Working now"
        count={running?.total}
        extra={queuedCount > 0 ? `${queuedCount} queued` : undefined}
        to="/tasks?status=in_progress"
      >
        <MobileList
          label="Tasks in progress"
          loading={runningLoading}
          emptyMessage="Nothing running"
        >
          {(running?.tasks ?? []).map((task) => (
            <MobileListRow
              key={task.id}
              to={`/tasks/${task.id}`}
              live
              title={taskListTitle(task)}
              meta={[agentName(task.agentId), formatElapsed(task.acceptedAt ?? task.createdAt)]}
            />
          ))}
        </MobileList>
      </NowSection>

      <NowSection
        title="Failed in the last 24h"
        count={recentFailures.length}
        to="/tasks?status=failed"
      >
        <MobileList
          label="Failed tasks"
          loading={failedLoading}
          emptyMessage="No failures in the last 24 hours"
        >
          {recentFailures.map((task) => (
            <MobileListRow
              key={task.id}
              to={`/tasks/${task.id}`}
              title={taskListTitle(task)}
              status={<StatusBadge status={task.status} />}
              meta={[
                agentName(task.agentId),
                formatRelativeTime(task.finishedAt ?? task.lastUpdatedAt),
              ]}
            />
          ))}
        </MobileList>
      </NowSection>
    </div>
  );
}

function NowSection({
  title,
  count,
  extra,
  to,
  children,
}: {
  title: string;
  count?: number;
  extra?: string;
  to: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
          {count !== undefined && count > 0 ? (
            <span className="ml-1.5 tabular-nums text-foreground">{count}</span>
          ) : null}
        </h2>
        {extra ? <span className="text-xs text-muted-foreground">· {extra}</span> : null}
        <Link
          to={to}
          className="ml-auto inline-flex min-h-11 items-center px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          View all
        </Link>
      </div>
      {children}
    </section>
  );
}
