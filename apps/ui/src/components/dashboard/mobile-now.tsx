/**
 * Home below `md`: a stacked "Now" view instead of the activity timeline.
 *
 * At 390px the timeline's label column takes a third of the width and the
 * visible window rarely holds a task block, so the first screen was an empty
 * grid with no next action. This view answers the three questions an
 * operator opens the app with on a phone: what is waiting on an answer, what
 * is running, and what broke.
 *
 * Every section tells a failed read apart from an empty one. "Nothing
 * running" when the request failed would reassure the operator about a
 * swarm nobody can see.
 */

import { AlertTriangle, ChevronRight, CircleCheck, Hourglass } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useApprovalRequests } from "@/api/hooks/use-approval-requests";
import { useTasks } from "@/api/hooks/use-tasks";
import type { AgentTask } from "@/api/types";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { summarizeRecentFailures } from "@/lib/recent-failures";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatElapsed, formatRelativeTime } from "@/lib/utils";

/** Failed tasks fetched to find the last 24h; past this the count reads "N+". */
const FAILURE_PAGE = 50;

/** The slice of a react-query result a section needs to render every state. */
export interface SectionQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  /**
   * Failed fetches so far. A refetch after an error resets `isError` to a
   * loading state while it runs; this keeps a section that has never loaded
   * showing "unavailable" instead of flickering back to a skeleton.
   */
  errorUpdateCount: number;
  refetch: () => unknown;
}

/** Nothing cached and at least one failed read: the section is unavailable. */
function isUnavailable(query: SectionQuery<unknown>): boolean {
  return query.data === undefined && (query.isError || query.errorUpdateCount > 0);
}

export interface MobileNowViewProps {
  approvals: SectionQuery<unknown[]>;
  running: SectionQuery<{ tasks: AgentTask[]; total: number }>;
  queuedCount: number;
  failed: SectionQuery<{ tasks: AgentTask[]; total: number }>;
  agentName: (id: string | null) => string;
  now: number;
}

export function MobileNow() {
  const approvals = useApprovalRequests({ status: "pending" });
  const running = useTasks({ status: "in_progress", limit: 20, orderBy: "lastUpdatedAt" });
  const { data: queued } = useTasks({ status: "pending", limit: 1 });
  const failed = useTasks({ status: "failed", limit: FAILURE_PAGE, orderBy: "lastUpdatedAt" });
  const { data: agents } = useAgents();

  const agentName = useMemo(() => {
    const names = new Map((agents ?? []).map((a) => [a.id, a.name]));
    return (id: string | null) => (id ? (names.get(id) ?? "Unknown agent") : "Unassigned");
  }, [agents]);

  return (
    <MobileNowView
      approvals={approvals}
      running={running}
      queuedCount={queued?.total ?? 0}
      failed={failed}
      agentName={agentName}
      now={Date.now()}
    />
  );
}

export function MobileNowView({
  approvals,
  running,
  queuedCount,
  failed,
  agentName,
  now,
}: MobileNowViewProps) {
  const recentFailures = useMemo(
    () => summarizeRecentFailures(failed.data?.tasks ?? [], FAILURE_PAGE, now),
    [failed.data, now],
  );

  return (
    <div className="flex flex-col gap-5">
      <ApprovalsCard approvals={approvals} />

      <NowSection
        title="Working now"
        count={running.data ? String(running.data.total) : undefined}
        extra={queuedCount > 0 ? `${queuedCount} queued` : undefined}
        to="/tasks?status=in_progress"
      >
        <SectionBody query={running} what="running tasks">
          <MobileList
            label="Tasks in progress"
            loading={running.isLoading}
            emptyMessage="Nothing running"
          >
            {(running.data?.tasks ?? []).map((task) => (
              <MobileListRow
                key={task.id}
                to={`/tasks/${task.id}`}
                live
                title={taskListTitle(task)}
                meta={[agentName(task.agentId), formatElapsed(task.acceptedAt ?? task.createdAt)]}
              />
            ))}
          </MobileList>
        </SectionBody>
      </NowSection>

      <NowSection
        title="Failed in the last 24h"
        count={
          failed.data
            ? `${recentFailures.tasks.length}${recentFailures.complete ? "" : "+"}`
            : undefined
        }
        to="/tasks?status=failed"
      >
        <SectionBody query={failed} what="failed tasks">
          <MobileList
            label="Failed tasks"
            loading={failed.isLoading}
            emptyMessage="No failures in the last 24 hours"
          >
            {recentFailures.tasks.map((task) => (
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
        </SectionBody>
      </NowSection>
    </div>
  );
}

function ApprovalsCard({ approvals }: { approvals: SectionQuery<unknown[]> }) {
  if (isUnavailable(approvals)) {
    return <Unavailable what="approvals" onRetry={approvals.refetch} />;
  }
  const pending = approvals.data?.length ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      <Link
        to="/approval-requests"
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-xl border px-4 py-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
          pending > 0
            ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
            : "border-border bg-card hover:bg-accent/40",
        )}
      >
        {pending > 0 ? (
          <Hourglass className="size-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <CircleCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">
            {approvals.isLoading
              ? "Checking approvals…"
              : pending > 0
                ? `${pending} pending ${pending === 1 ? "approval" : "approvals"}`
                : "No pending approvals"}
          </span>
          {approvals.isLoading ? null : (
            <span className="text-xs text-muted-foreground">
              {pending > 0 ? "Agents are waiting on an answer" : "No agent is waiting on an answer"}
            </span>
          )}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
      {approvals.isError ? <StaleNotice onRetry={approvals.refetch} /> : null}
    </div>
  );
}

/**
 * Renders the section's list, or an "unavailable" state when the read failed
 * with nothing cached. With cached data and a failed refresh, the list stays
 * and a stale notice sits above it.
 */
function SectionBody({
  query,
  what,
  children,
}: {
  query: SectionQuery<unknown>;
  what: string;
  children: ReactNode;
}) {
  if (isUnavailable(query)) {
    return <Unavailable what={what} onRetry={query.refetch} />;
  }
  return (
    <>
      {query.isError ? <StaleNotice onRetry={query.refetch} /> : null}
      {children}
    </>
  );
}

function Unavailable({ what, onRetry }: { what: string; onRetry: () => unknown }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-xl border border-status-error/40 bg-status-error/5 px-4 py-3"
    >
      <AlertTriangle className="size-4 shrink-0 text-status-error-strong" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">Couldn't load {what}</span>
        <span className="text-xs text-muted-foreground">Unknown, not empty. Check the API.</span>
      </span>
      <Button variant="outline" size="sm" className="h-11 shrink-0" onClick={() => onRetry()}>
        Retry
      </Button>
    </div>
  );
}

function StaleNotice({ onRetry }: { onRetry: () => unknown }) {
  return (
    <p className="flex items-center gap-2 px-1 text-xs text-status-warning-strong">
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">Refresh failed. Showing earlier data.</span>
      <button
        type="button"
        onClick={() => onRetry()}
        className="inline-flex min-h-11 items-center px-1 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        Retry
      </button>
    </p>
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
  /** Preformatted count, e.g. "3" or "50+". Hidden when absent or "0". */
  count?: string;
  extra?: string;
  to: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
          {count !== undefined && count !== "0" ? (
            <span className="ml-1.5 tabular-nums text-foreground">{count}</span>
          ) : null}
        </h2>
        {extra ? <span className="text-xs text-muted-foreground">· {extra}</span> : null}
        <Link
          to={to}
          className="ml-auto inline-flex min-h-11 items-center px-1 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          View all
        </Link>
      </div>
      {children}
    </section>
  );
}
