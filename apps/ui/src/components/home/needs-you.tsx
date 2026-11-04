/**
 * "Needs you" on Home: pending approvals, sessions that need the viewer,
 * agents blocked on credentials, and failures of the last 24 hours. The
 * first three make the count, which the sidebar Home badge shows too
 * (`useNeedsYou`). Failures are listed below them but not counted: a failed
 * task stays failed, so it would hold the badge up for a whole day.
 */

import type { LucideIcon } from "lucide-react";
import { Check, CircleAlert, ClipboardCheck, KeyRound, MessageCircle } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useSessionLabels } from "@/api/hooks/use-session-tree";
import { useTasks } from "@/api/hooks/use-tasks";
import type {
  AgentTask,
  ApprovalRequestSummary,
  CredentialMissingAgent,
  SessionListItem,
} from "@/api/types";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { useNeedsYou } from "@/hooks/use-needs-you";
import { quorumLabel } from "@/lib/approval-format";
import { failuresNotListed, type NeedsYouItems } from "@/lib/needs-you";
import { summarizeRecentFailures } from "@/lib/recent-failures";
import { groupLabel } from "@/lib/session-groups";
import { taskListTitle } from "@/lib/task-title";
import { formatRelativeTime } from "@/lib/utils";
import { HomeWidget, HomeWidgetEmpty, HomeWidgetLink } from "./home-widget";
import { isUnavailable, SectionBody, type SectionQuery } from "./section-state";

/** Failed tasks fetched to find the last 24h; past this the count reads "N+". */
const FAILURE_PAGE = 50;
/** Rows per list before a "View all" link takes over. */
const MAX_ROWS = 5;
const MAX_FAILURE_ROWS = 3;

export function NeedsYou({ className }: { className?: string }) {
  const { items, count, approvals, sessions, credentials } = useNeedsYou();
  const failed = useTasks({ status: "failed", limit: FAILURE_PAGE, orderBy: "lastUpdatedAt" });
  const { data: agents } = useAgents();
  const { userId } = useCurrentUser();
  const labels = useSessionLabels();
  const now = useMinuteClock();

  const agentName = useMemo(() => {
    const names = new Map((agents ?? []).map((a) => [a.id, a.name]));
    return (id: string | null | undefined) => (id ? (names.get(id) ?? "Unknown agent") : null);
  }, [agents]);

  return (
    <NeedsYouView
      className={className}
      items={items}
      count={count}
      approvals={approvals}
      sessions={sessions}
      credentials={credentials}
      failed={failed}
      agentName={agentName}
      groupName={(key) => groupLabel(key, userId ?? null, labels) || "No group"}
      now={now}
    />
  );
}

export interface NeedsYouViewProps {
  className?: string;
  items: NeedsYouItems;
  count: number;
  approvals: SectionQuery<unknown>;
  sessions: SectionQuery<unknown>;
  credentials: SectionQuery<unknown>;
  failed: SectionQuery<{ tasks: AgentTask[] }>;
  agentName: (id: string | null | undefined) => string | null;
  groupName: (key: string | undefined) => string;
  now: number;
}

export function NeedsYouView({
  className,
  items,
  count,
  approvals,
  sessions,
  credentials,
  failed,
  agentName,
  groupName,
  now,
}: NeedsYouViewProps) {
  const recent = useMemo(
    () => summarizeRecentFailures(failed.data?.tasks ?? [], FAILURE_PAGE, now),
    [failed.data, now],
  );
  const failures = failuresNotListed(recent.tasks, items.sessions);
  const loading =
    (approvals.isLoading && !approvals.data) ||
    (sessions.isLoading && !sessions.data) ||
    (credentials.isLoading && !credentials.data);
  const failuresKnown = failed.data !== undefined;
  const credentialsKnown = credentials.data !== undefined;
  const nothing =
    !loading &&
    count === 0 &&
    failures.length === 0 &&
    !isUnavailable(approvals) &&
    !isUnavailable(sessions) &&
    !isUnavailable(failed);

  return (
    <HomeWidget
      className={className}
      title="Needs you"
      icon={<CircleAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      meta={
        count > 0 ? (
          <span
            role="img"
            aria-label={`${count} ${count === 1 ? "item needs" : "items need"} you`}
            className="grid h-[18px] min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5 font-mono text-[11px] font-bold text-primary-foreground tabular-nums"
          >
            {count}
          </span>
        ) : null
      }
      action={<HomeWidgetLink to="/sessions">All sessions</HomeWidgetLink>}
      footer={
        <AllClearLine
          credentialsClear={credentialsKnown && items.credentials.length === 0}
          failuresClear={failuresKnown && failures.length === 0 && recent.complete}
        />
      }
    >
      {loading ? (
        <LoadingRows />
      ) : nothing ? (
        <HomeWidgetEmpty>Nothing needs you.</HomeWidgetEmpty>
      ) : (
        <div className="divide-y divide-border-subtle">
          <SectionBody query={approvals} what="approvals">
            {items.approvals.slice(0, MAX_ROWS).map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} />
            ))}
            {items.approvals.length > MAX_ROWS ? (
              <MoreRow to="/approval-requests?status=pending">
                {items.approvals.length - MAX_ROWS} more approvals
              </MoreRow>
            ) : null}
          </SectionBody>
          <SectionBody query={sessions} what="sessions">
            {items.sessions.slice(0, MAX_ROWS).map((session) => (
              <SessionRow key={session.root.id} session={session} groupName={groupName} />
            ))}
            {items.sessions.length > MAX_ROWS ? (
              <MoreRow to="/sessions?view=inbox">
                {items.sessions.length - MAX_ROWS} more sessions
              </MoreRow>
            ) : null}
          </SectionBody>
          {items.credentials.map((agent) => (
            <CredentialRow key={agent.agentId} agent={agent} />
          ))}
          <SectionBody query={failed} what="failed tasks">
            {failures.length > 0 ? (
              <div>
                <div className="flex h-9 items-center gap-2 pl-4 pr-3 text-xs text-muted-foreground">
                  <span className="font-medium uppercase tracking-wide">
                    Failed in the last 24h
                  </span>
                  <span className="font-mono tabular-nums text-foreground">
                    {failures.length}
                    {recent.complete ? "" : "+"}
                  </span>
                  <Link
                    to="/tasks?status=failed"
                    className="ml-auto rounded-md px-2 py-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    View all
                  </Link>
                </div>
                {failures.slice(0, MAX_FAILURE_ROWS).map((task) => (
                  <FailureRow key={task.id} task={task} agent={agentName(task.agentId)} />
                ))}
              </div>
            ) : null}
          </SectionBody>
        </div>
      )}
    </HomeWidget>
  );
}

function AllClearLine({
  credentialsClear,
  failuresClear,
}: {
  credentialsClear: boolean;
  failuresClear: boolean;
}) {
  const text =
    credentialsClear && failuresClear
      ? "No blocked agents and no failed runs in the last 24h."
      : credentialsClear
        ? "No blocked agents."
        : failuresClear
          ? "No failed runs in the last 24h."
          : null;
  if (!text) return null;
  return (
    <>
      <Check className="size-3.5 shrink-0 text-status-success-strong" aria-hidden />
      {text}
    </>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-3 px-4 py-3" aria-busy="true">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/**
 * One row: an icon tile, two lines, and one action. The title link covers the
 * whole row; the action sits above it.
 */
function NeedsRow({
  icon: Icon,
  title,
  meta,
  to,
  action,
}: {
  icon: LucideIcon;
  title: string;
  meta: ReactNode;
  to: string;
  action: string;
}) {
  return (
    <div className="relative flex min-h-[52px] items-center gap-3 px-4 py-2 transition-colors hover:bg-accent focus-within:bg-accent">
      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border-subtle bg-surface">
        <Icon className="size-3.5 text-foreground" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to={to}
          className="block truncate text-sm font-medium leading-snug outline-none after:absolute after:inset-0 focus-visible:underline"
        >
          {title}
        </Link>
        <p className="truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      <Button asChild size="xs" variant="outline" className="relative z-10 shrink-0">
        <Link to={to} tabIndex={-1} aria-hidden>
          {action}
        </Link>
      </Button>
    </div>
  );
}

function ApprovalRow({ approval }: { approval: ApprovalRequestSummary }) {
  const meta = [
    approval.workflowRunId ? "Workflow approval" : "Approval",
    `${approval.questionCount} ${approval.questionCount === 1 ? "question" : "questions"}`,
    quorumLabel(approval.approvalProgress),
    formatRelativeTime(approval.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <NeedsRow
      icon={ClipboardCheck}
      title={approval.title || "Approval requested"}
      meta={meta}
      to={`/approval-requests/${approval.id}`}
      action="Review"
    />
  );
}

function SessionRow({
  session,
  groupName,
}: {
  session: SessionListItem;
  groupName: (key: string | undefined) => string;
}) {
  return (
    <NeedsRow
      icon={MessageCircle}
      title={taskListTitle(session.root)}
      meta={[
        session.latestStatus === "failed" ? "Failed" : "Waiting on you",
        groupName(session.groupKey),
        formatRelativeTime(session.lastActivityAt),
      ].join(" · ")}
      to={`/sessions/${session.root.id}`}
      action="Open"
    />
  );
}

function CredentialRow({ agent }: { agent: CredentialMissingAgent }) {
  const missing =
    agent.credStatus?.missing && agent.credStatus.missing.length > 0
      ? agent.credStatus.missing
      : agent.missing;
  const meta = missing.length
    ? `Missing ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? `, +${missing.length - 3}` : ""}`
    : "Waiting for credentials";
  return (
    <NeedsRow
      icon={KeyRound}
      title={`${agent.name || "An agent"} is blocked on credentials`}
      meta={meta}
      to={`/agents/${agent.agentId}`}
      action="Fix"
    />
  );
}

function FailureRow({ task, agent }: { task: AgentTask; agent: string | null }) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="grid h-9 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 px-4 text-[13px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
    >
      <TaskStatusIcon status="failed" label="Failed" className="size-3.5" />
      <span className="truncate">{taskListTitle(task)}</span>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {[agent, formatRelativeTime(task.finishedAt ?? task.lastUpdatedAt)]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </Link>
  );
}

function MoreRow({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="block px-4 py-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
    >
      {children}
    </Link>
  );
}
