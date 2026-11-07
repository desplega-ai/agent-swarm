/**
 * "Needs you" on Home: pending approvals, sessions that need the viewer,
 * agents blocked on credentials, and failures of the last 24 hours. The
 * first three make the count, which the sidebar Home badge shows too
 * (`useNeedsYou`). Failures are listed below them but not counted: a failed
 * task stays failed, so it would hold the badge up for a whole day.
 */

import type { LucideIcon } from "lucide-react";
import {
  Check,
  CircleAlert,
  CircleX,
  ClipboardCheck,
  Eye,
  KeyRound,
  MessageCircle,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAgents } from "@/api/hooks/use-agents";
import { useSessionLabels } from "@/api/hooks/use-session-tree";
import { useSessions } from "@/api/hooks/use-sessions";
import { useRetryTask, useTasks } from "@/api/hooks/use-tasks";
import type {
  AgentTask,
  ApprovalRequestSummary,
  CredentialMissingAgent,
  SessionListItem,
} from "@/api/types";
import { Badge } from "@/components/ui/badge";
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
import { cn, formatRelativeTime } from "@/lib/utils";
import { HomeWidget, HomeWidgetLink } from "./home-widget";
import { isUnavailable, SectionBody, type SectionQuery } from "./section-state";

/** Failed tasks fetched to find the last 24h; past this the count reads "N+". */
const FAILURE_PAGE = 50;
/** Rows per list before a "View all" link takes over. */
const MAX_ROWS = 5;
const MAX_FAILURE_ROWS = 5;
/** Unread sessions read for "To review"; the days they reach back. */
const REVIEW_PAGE = 30;
const REVIEW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a row asks for, and its colour: decisions amber, failures red, blocked orange, reviews blue. */
type RowTone = "decide" | "failed" | "blocked" | "review";
const TONE: Record<RowTone, { tile: string; icon: string; chip: string }> = {
  decide: {
    tile: "border-status-active/40 bg-status-active/10",
    icon: "text-status-active-strong",
    chip: "border-status-active/40 text-status-active-strong",
  },
  failed: {
    tile: "border-status-error/40 bg-status-error/10",
    icon: "text-status-error-strong",
    chip: "border-status-error/40 text-status-error-strong",
  },
  blocked: {
    tile: "border-status-warning/40 bg-status-warning/10",
    icon: "text-status-warning-strong",
    chip: "border-status-warning/40 text-status-warning-strong",
  },
  review: {
    tile: "border-status-info/40 bg-status-info/10",
    icon: "text-status-info-strong",
    chip: "border-status-info/40 text-status-info-strong",
  },
};

/**
 * Unread sessions of the last days that ended (done, not failed) and are not
 * listed above: results waiting for a look. Newest first.
 */
export function sessionsToReview(
  unread: SessionListItem[],
  listed: SessionListItem[],
  now: number,
): SessionListItem[] {
  const seen = new Set(listed.map((session) => session.root.id));
  return unread.filter(
    (session) =>
      !seen.has(session.root.id) &&
      session.readState === "unread" &&
      session.latestStatus === "completed" &&
      now - new Date(session.lastActivityAt).getTime() < REVIEW_DAYS * DAY_MS,
  );
}

type NeedsFilter = "all" | "approvals" | "waiting" | "blocked" | "failed" | "review";

export function NeedsYou({ className }: { className?: string }) {
  const { items, count, approvals, sessions, credentials } = useNeedsYou();
  const failed = useTasks({ status: "failed", limit: FAILURE_PAGE, orderBy: "lastUpdatedAt" });
  const unread = useSessions({ triage: "unread", scope: "tree", limit: REVIEW_PAGE });
  const { data: agents } = useAgents();
  const { userId } = useCurrentUser();
  const labels = useSessionLabels();
  const now = useMinuteClock();
  const retry = useRetryTask();
  const navigate = useNavigate();
  const onRetry = (task: AgentTask) =>
    retry.mutate(
      { task, userId: userId ?? null },
      {
        onSuccess: (created) =>
          toast.success("Retry started", {
            action: { label: "Open", onClick: () => navigate(`/tasks/${created.id}`) },
          }),
      },
    );

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
      onRetry={onRetry}
      retrying={retry.isPending ? (retry.variables?.task.id ?? null) : null}
      review={sessionsToReview(unread.data?.sessions ?? [], sessions.data?.sessions ?? [], now)}
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
  /** Retry a failed task; without it a failure row links to the task. */
  onRetry?: (task: AgentTask) => void;
  /** The failed task a retry is running for. */
  retrying?: string | null;
  /** Finished, unread sessions of the last days (`sessionsToReview`). Not counted in the badge. */
  review?: SessionListItem[];
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
  onRetry,
  retrying = null,
  review = [],
}: NeedsYouViewProps) {
  const [filter, setFilter] = useState<NeedsFilter>("all");
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
    review.length === 0 &&
    !isUnavailable(approvals) &&
    !isUnavailable(sessions) &&
    !isUnavailable(failed);

  // All good: one quiet line, so the space goes to the activity below.
  if (nothing) {
    return (
      <HomeWidget
        className={className}
        title="Needs you"
        icon={<Check className="size-4 shrink-0 text-status-success-strong" aria-hidden />}
        meta={
          <span className="truncate text-xs text-muted-foreground">
            All good. Nothing waits on you.
          </span>
        }
        action={<HomeWidgetLink to="/sessions">All sessions</HomeWidgetLink>}
      />
    );
  }

  return (
    <HomeWidget
      className={className}
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
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
      ) : (
        <div>
          <FilterChips
            filter={filter}
            onFilter={setFilter}
            counts={{
              approvals: items.approvals.length,
              waiting: items.sessions.length,
              blocked: items.credentials.length,
              failed: failures.length,
              review: review.length,
            }}
          />
          {/* j / k (or the arrows) move between rows; Enter opens one. */}
          <div className="divide-y divide-border-subtle" onKeyDown={moveBetweenRows}>
            {show(filter, "approvals") ? (
              <SectionBody query={approvals} what="approvals">
                {items.approvals.slice(0, MAX_ROWS).map((approval, index) => (
                  <ApprovalRow key={approval.id} approval={approval} primary={index === 0} />
                ))}
                {items.approvals.length > MAX_ROWS ? (
                  <MoreRow to="/approval-requests?status=pending">
                    {items.approvals.length - MAX_ROWS} more approvals
                  </MoreRow>
                ) : null}
              </SectionBody>
            ) : null}
            {show(filter, "waiting") ? (
              <SectionBody query={sessions} what="sessions">
                {items.sessions.slice(0, MAX_ROWS).map((session, index) => (
                  <SessionRow
                    key={session.root.id}
                    session={session}
                    groupName={groupName}
                    primary={index === 0 && (filter !== "all" || items.approvals.length === 0)}
                  />
                ))}
                {items.sessions.length > MAX_ROWS ? (
                  <MoreRow to="/sessions?view=inbox">
                    {items.sessions.length - MAX_ROWS} more sessions
                  </MoreRow>
                ) : null}
              </SectionBody>
            ) : null}
            {show(filter, "blocked")
              ? items.credentials.map((agent) => (
                  <CredentialRow key={agent.agentId} agent={agent} />
                ))
              : null}
            {show(filter, "failed") ? (
              <SectionBody query={failed} what="failed tasks">
                {failures.length > 0 ? (
                  <div className="divide-y divide-border-subtle">
                    <SectionHeader to="/tasks?status=failed">
                      Failed in the last 24h
                      <span className="font-mono tabular-nums text-foreground">
                        {failures.length}
                        {recent.complete ? "" : "+"}
                      </span>
                    </SectionHeader>
                    {failures.slice(0, MAX_FAILURE_ROWS).map((task) => (
                      <FailureRow
                        key={task.id}
                        task={task}
                        agent={agentName(task.agentId)}
                        onRetry={onRetry}
                        retrying={retrying === task.id}
                      />
                    ))}
                  </div>
                ) : null}
              </SectionBody>
            ) : null}
            {show(filter, "review") && review.length > 0 ? (
              <div className="divide-y divide-border-subtle">
                <SectionHeader to="/sessions?view=inbox">
                  To review, last {REVIEW_DAYS} days
                  <span className="font-mono tabular-nums text-foreground">{review.length}</span>
                </SectionHeader>
                {review.slice(0, MAX_ROWS).map((session) => (
                  <NeedsRow
                    key={session.root.id}
                    icon={Eye}
                    tone="review"
                    kind="To review"
                    title={taskListTitle(session.root)}
                    meta={[
                      groupName(session.groupKey),
                      formatRelativeTime(session.lastActivityAt),
                    ].join(" · ")}
                    to={`/sessions/${session.root.id}`}
                    action="Open"
                  />
                ))}
              </div>
            ) : null}
          </div>
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

function show(filter: NeedsFilter, kind: Exclude<NeedsFilter, "all">): boolean {
  return filter === "all" || filter === kind;
}

const FILTER_LABELS: Record<Exclude<NeedsFilter, "all">, string> = {
  approvals: "Approvals",
  waiting: "Waiting",
  blocked: "Blocked",
  failed: "Failed",
  review: "To review",
};

/** All, then one chip per kind that has rows. Hidden when only one kind does. */
function FilterChips({
  filter,
  onFilter,
  counts,
}: {
  filter: NeedsFilter;
  onFilter: (filter: NeedsFilter) => void;
  counts: Record<Exclude<NeedsFilter, "all">, number>;
}) {
  const kinds = (Object.keys(FILTER_LABELS) as Exclude<NeedsFilter, "all">[]).filter(
    (kind) => counts[kind] > 0,
  );
  if (kinds.length < 2) return null;
  const total = kinds.reduce((sum, kind) => sum + counts[kind], 0);
  const chip = (value: NeedsFilter, label: string, count: number) => (
    <button
      key={value}
      type="button"
      aria-pressed={filter === value}
      onClick={() => onFilter(value)}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
        filter === value
          ? "border-foreground/30 bg-accent text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <span className="font-mono tabular-nums">{count}</span>
    </button>
  );
  return (
    <div className="flex gap-1.5 overflow-x-auto px-4 py-2.5 [scrollbar-width:none]">
      {chip("all", "All", total)}
      {kinds.map((kind) => chip(kind, FILTER_LABELS[kind], counts[kind]))}
    </div>
  );
}

/** j / k and the arrow keys move focus between the rows' title links. */
function moveBetweenRows(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const step =
    event.key === "j" || event.key === "ArrowDown"
      ? 1
      : event.key === "k" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (step === 0) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-needs-row]")];
  if (links.length === 0) return;
  event.preventDefault();
  const at = links.indexOf(document.activeElement as HTMLElement);
  const next = at === -1 ? 0 : Math.min(links.length - 1, Math.max(0, at + step));
  links[next]?.focus();
}

/** A group label inside the queue, with a "View all" link. */
function SectionHeader({ to, children }: { to: string; children: ReactNode }) {
  return (
    <div className="flex h-9 items-center gap-2 pl-4 pr-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-2 font-medium uppercase tracking-wide">
        {children}
      </span>
      <Link
        to={to}
        className="ml-auto rounded-md px-2 py-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        View all
      </Link>
    </div>
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
 * One row: an icon tile, the title over a kind chip and meta, an optional
 * reason, and one action. The title link covers the whole row; the action
 * sits above it. The queue's top row gets the primary (amber) action.
 */
function NeedsRow({
  icon: Icon,
  tone,
  kind,
  title,
  meta,
  why,
  to,
  action,
  primary = false,
}: {
  icon: LucideIcon;
  tone: RowTone;
  kind: string;
  title: string;
  meta: ReactNode;
  why?: string | null;
  to: string;
  action: string | ReactNode;
  primary?: boolean;
}) {
  return (
    <div className="group/row relative flex min-h-[56px] items-center gap-3 px-4 py-2 transition-colors hover:bg-accent focus-within:bg-accent">
      <span
        className={cn("grid size-7 shrink-0 place-items-center rounded-md border", TONE[tone].tile)}
      >
        <Icon className={cn("size-3.5", TONE[tone].icon)} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to={to}
          data-needs-row
          className="block truncate text-sm font-medium leading-snug outline-none after:absolute after:inset-0 focus-visible:underline"
        >
          {title}
        </Link>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="outline" size="tag" className={cn("shrink-0", TONE[tone].chip)}>
            {kind}
          </Badge>
          <span className="truncate">{meta}</span>
        </p>
      </div>
      {why ? (
        <span
          className="hidden max-w-[16rem] shrink truncate text-xs text-status-error-strong lg:block"
          title={why}
        >
          {why}
        </span>
      ) : null}
      {typeof action === "string" ? (
        <Button
          asChild
          size="xs"
          variant={primary ? "default" : "outline"}
          className="relative z-10 shrink-0"
        >
          <Link to={to} tabIndex={-1} aria-hidden>
            {action}
          </Link>
        </Button>
      ) : (
        <div className="relative z-10 shrink-0">{action}</div>
      )}
    </div>
  );
}

function ApprovalRow({
  approval,
  primary,
}: {
  approval: ApprovalRequestSummary;
  primary?: boolean;
}) {
  const meta = [
    approval.workflowRunId ? "Workflow" : null,
    `${approval.questionCount} ${approval.questionCount === 1 ? "question" : "questions"}`,
    quorumLabel(approval.approvalProgress),
    formatRelativeTime(approval.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <NeedsRow
      icon={ClipboardCheck}
      tone="decide"
      kind="Approval"
      primary={primary}
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
  primary,
}: {
  session: SessionListItem;
  groupName: (key: string | undefined) => string;
  primary?: boolean;
}) {
  return (
    <NeedsRow
      icon={MessageCircle}
      tone={session.latestStatus === "failed" ? "failed" : "decide"}
      kind={session.latestStatus === "failed" ? "Failed" : "Waiting"}
      primary={primary}
      title={taskListTitle(session.root)}
      meta={[groupName(session.groupKey), formatRelativeTime(session.lastActivityAt)].join(" · ")}
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
      tone="blocked"
      kind="Blocked"
      title={`${agent.name || "An agent"} is blocked on credentials`}
      meta={meta}
      to={`/agents/${agent.agentId}`}
      action="Fix"
    />
  );
}

/** The first line of a failure reason, short enough for one row. */
function firstLine(reason: string | undefined): string | null {
  const line = reason
    ?.split("\n")
    .find((part) => part.trim())
    ?.trim();
  return line ? line : null;
}

function FailureRow({
  task,
  agent,
  onRetry,
  retrying,
}: {
  task: AgentTask;
  agent: string | null;
  onRetry?: (task: AgentTask) => void;
  retrying: boolean;
}) {
  const to = `/tasks/${task.id}`;
  return (
    <NeedsRow
      icon={CircleX}
      tone="failed"
      kind="Failed"
      title={taskListTitle(task)}
      meta={[agent, formatRelativeTime(task.finishedAt ?? task.lastUpdatedAt)]
        .filter(Boolean)
        .join(" · ")}
      why={firstLine(task.failureReason)}
      to={to}
      action={
        onRetry ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={retrying}
            onClick={() => onRetry(task)}
            aria-label={`Retry ${taskListTitle(task)}`}
          >
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        ) : (
          "Open"
        )
      }
    />
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
