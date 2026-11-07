import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAgent } from "@/api/hooks/use-agents";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import { useTask } from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ModelEffortLabel } from "@/components/shared/model-effort-label";
import { RelativeTime } from "@/components/shared/relative-time";
import { TaskSourceMark, taskSourceLabel } from "@/components/shared/task-source-mark";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCost } from "@/lib/cost-format";
import { parseJsonOutput } from "@/lib/json-output";
import { markdownPreview } from "@/lib/markdown-preview";
import { modelTierLabel } from "@/lib/model-tiers";
import { parsePromptDisplay } from "@/lib/prompt-display";
import { shortId } from "@/lib/short-id";
import { statusLabel } from "@/lib/status-labels";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { taskDisplayEffort, taskDisplayModel } from "@/lib/task-model-resolution";
import { taskListTitle, taskPromptPreview } from "@/lib/task-title";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

/** Statuses whose clock still runs. */
const LIVE_STATUSES = new Set(["pending", "offered", "in_progress"]);

type TaskHoverCardVariant = "full" | "compact";

/**
 * A task as a hover card: status, title and short id, then who, where from,
 * which model, when and how much. The `full` variant (task lists) adds a
 * prompt preview, the outcome and an "Open task" link. The `compact` variant
 * (breadcrumb crumbs) stops after the details. Radix opens it on pointer
 * hover and on keyboard focus of the trigger. The body mounts only while
 * open, so a closed card costs nothing.
 */
export function TaskHoverCard({
  task,
  children,
  variant = "full",
  side = "right",
  align = "start",
  openDelay = 400,
}: {
  task: AgentTask;
  children: ReactNode;
  variant?: TaskHoverCardVariant;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  openDelay?: number;
}) {
  return (
    <HoverCard openDelay={openDelay} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side={side}
        align={align}
        collisionPadding={8}
        className="w-[22rem] max-w-[calc(100vw-1rem)] divide-y divide-border-subtle p-0"
      >
        {variant === "full" ? <FullCardBody task={task} /> : <CardBody task={task} />}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The full card. Task list rows leave out the outcome and the source-control
 * fields, so it reads the task (`GET /api/tasks/:id`, the query the detail
 * page uses) once when it opens. Everything else renders from the row at once.
 */
function FullCardBody({ task }: { task: AgentTask }) {
  const { data: detail, isLoading } = useTask(task.id, { refetchInterval: false });
  const prompt = markdownPreview(taskPromptPreview(task));
  const isTerminal = TERMINAL_STATUSES.has(task.status);
  const outcome = isTerminal ? taskOutcome(task.status, detail) : null;
  const progress = !isTerminal && task.progress ? markdownPreview(task.progress) : "";
  const showPreview = !!prompt || !!outcome || !!progress || (isTerminal && isLoading);
  return (
    <>
      <CardBody task={task} pullRequest={vcsRef(task, detail)} />
      {showPreview ? (
        <div className="space-y-2.5 px-4 py-3">
          {prompt ? (
            <CardPreview label="Prompt" lines={isTerminal ? 2 : 3} muted>
              {prompt}
            </CardPreview>
          ) : null}
          {progress ? (
            <CardPreview label="Progress" lines={2} muted>
              {progress}
            </CardPreview>
          ) : null}
          {outcome ? (
            <CardPreview label={outcome.label} tone={outcome.tone} mono={outcome.mono}>
              {outcome.text}
            </CardPreview>
          ) : isTerminal && isLoading ? (
            <div aria-hidden className="space-y-1.5 pt-0.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="px-4 py-2">
        <Link
          to={`/tasks/${task.id}`}
          // The card is portalled out of the grid row; keep the click on the link anyway.
          onClick={(e) => e.stopPropagation()}
          className="hover-linger inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          Open task
          <ArrowRight aria-hidden className="size-3" />
        </Link>
      </div>
    </>
  );
}

/**
 * "owner/repo#123" for a task that came from its VCS provider (a GitHub PR, a
 * GitLab MR). Other tasks can carry a repo they worked on: the rail lists it.
 */
function vcsRef(
  task: AgentTask,
  detail: Pick<AgentTask, "vcsProvider" | "vcsRepo" | "vcsNumber"> | undefined,
): string | null {
  if (!detail?.vcsRepo || detail.vcsProvider !== task.source) return null;
  return detail.vcsNumber ? `${detail.vcsRepo}#${detail.vcsNumber}` : detail.vcsRepo;
}

interface CardOutcome {
  label: string;
  text: string;
  tone?: "error";
  mono?: boolean;
}

/** The outcome's first words, with `TaskOutcome`'s labels. Null when there is none. */
function taskOutcome(
  status: AgentTask["status"],
  detail: Pick<AgentTask, "output" | "failureReason"> | undefined,
): CardOutcome | null {
  if (!detail) return null;
  if (status === "failed" || status === "cancelled") {
    const text = markdownPreview(detail.failureReason ?? "");
    if (!text) return null;
    // Cancelled is a neutral state (DESIGN.md status vocabulary): only a failure reads red.
    return status === "failed"
      ? { label: "Failure", text, tone: "error" }
      : { label: "Cancelled", text };
  }
  const output = detail.output?.trim();
  if (!output) return null;
  const json = parseJsonOutput(output);
  if (json) return { label: "Outcome", text: JSON.stringify(json), mono: true };
  const text = markdownPreview(output);
  return text ? { label: "Outcome", text } : null;
}

const LINE_CLAMP = { 2: "line-clamp-2", 3: "line-clamp-3" } as const;

function CardPreview({
  label,
  children,
  lines = 3,
  muted = false,
  tone,
  mono = false,
}: {
  label: string;
  children: string;
  lines?: keyof typeof LINE_CLAMP;
  muted?: boolean;
  tone?: "error";
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p
        className={cn(
          "text-meta font-medium text-muted-foreground",
          tone === "error" && "text-status-error-strong",
        )}
      >
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 text-data leading-5 wrap-anywhere",
          LINE_CLAMP[lines],
          muted ? "text-muted-foreground" : "text-foreground",
          mono && "font-mono text-xs",
        )}
      >
        {children}
      </p>
    </div>
  );
}

/** The header and the detail rows: everything here comes from the list row. */
function CardBody({
  task,
  pullRequest = null,
}: {
  task: AgentTask;
  /** "owner/repo#123", once the full task is loaded. */
  pullRequest?: string | null;
}) {
  // The avatar reads the same queries, and the list already loaded the users,
  // so the names cost no extra request.
  const { data: agent } = useAgent(task.agentId ?? "");
  const { data: users } = useUsers();
  const { data: modelsCatalog } = useModelsCatalog();

  const agentName = task.agentId ? (agent?.name ?? `${task.agentId.slice(0, 8)}…`) : null;
  const user = task.requestedByUserId
    ? users?.find((u) => u.id === task.requestedByUserId)
    : undefined;
  const requestedBy =
    user?.name?.trim() ||
    user?.email?.trim() ||
    parsePromptDisplay(task.task).speaker ||
    (task.requestedByUserId ? `${task.requestedByUserId.slice(0, 8)}…` : null);

  const model = taskDisplayModel(task);
  const start = task.acceptedAt ?? task.createdAt;
  const duration = task.finishedAt
    ? formatElapsed(start, task.finishedAt)
    : LIVE_STATUSES.has(task.status)
      ? formatElapsed(start)
      : null;
  const cost = task.totalCostUsd;
  const status = statusLabel(task.status);

  return (
    <>
      <div className="flex items-start gap-2.5 px-4 py-3">
        <TaskStatusIcon status={task.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-5 break-words">
            {taskListTitle(task)}
          </p>
          <p className="mt-0.5 text-meta text-muted-foreground">
            {status} · <span className="font-mono">#{shortId(task.id)}</span>
          </p>
        </div>
      </div>
      <dl className="px-4 py-2.5">
        <CardRow label="Agent">
          {task.agentId ? (
            <span className="inline-flex max-w-full items-center gap-1.5">
              <AgentAvatar
                agentId={task.agentId}
                agentName={agentName}
                size="xs"
                className="size-4.5 shadow-none"
              />
              <span className="truncate">{agentName}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Not assigned</span>
          )}
        </CardRow>
        {requestedBy ? (
          <CardRow label="Requested by">
            <span className="block truncate">{requestedBy}</span>
          </CardRow>
        ) : null}
        {task.source ? (
          <CardRow label="Source">
            <span className="flex min-w-0 items-center gap-1.5">
              <TaskSourceMark source={task.source} className="text-muted-foreground" />
              <span className="shrink-0">{taskSourceLabel(task.source)}</span>
              {pullRequest ? (
                // Middle-truncated, so the PR number at the end stays visible.
                <MiddleTruncation
                  minEnd={8}
                  className="min-w-0 flex-1 font-mono text-xs text-muted-foreground"
                >
                  {pullRequest}
                </MiddleTruncation>
              ) : null}
            </span>
          </CardRow>
        ) : null}
        {model ? (
          <CardRow label="Model">
            <ModelEffortLabel
              model={model}
              effort={taskDisplayEffort(task)}
              catalog={modelsCatalog?.providers}
              className="max-w-full"
            />
          </CardRow>
        ) : task.modelTier ? (
          <CardRow label="Model">{modelTierLabel(task.modelTier)} tier</CardRow>
        ) : null}
        <CardRow label={task.acceptedAt ? "Started" : "Created"} mono>
          <RelativeTime at={start}>{formatSmartTime(start)}</RelativeTime>
          {duration ? <span className="text-muted-foreground"> · {duration}</span> : null}
        </CardRow>
        {cost != null ? (
          <CardRow label="Cost" mono>
            {formatCost(cost, { precision: cost > 0 && cost < 1 ? 4 : "auto" })}
          </CardRow>
        ) : null}
      </dl>
    </>
  );
}

/** One label and value, in the task details rail's style at the card's width. */
function CardRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 py-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-data leading-5", mono && "font-mono tabular-nums")}>
        {children}
      </dd>
    </div>
  );
}
