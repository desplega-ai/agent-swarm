import { ExternalLink, GitBranch, Github, Gitlab, GitPullRequest, Link2, User } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  AgentLog,
  DevinProviderMeta,
  SessionCost,
  TaskContextResponse,
  TaskWithLogs,
} from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { CostSourceBadge, costDriftPercent } from "@/components/shared/cost-source-badge";
import { SessionId } from "@/components/shared/session-id";
import type { EndSummary } from "@/components/shared/session-log-messages";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { findLatestUsableContextSnapshot } from "@/lib/context-display";
import { formatCost } from "@/lib/cost-format";
import { formatDurationMs } from "@/lib/format-duration-ms";
import { formatTokens } from "@/lib/format-tokens";
import { progressBarTone } from "@/lib/percent-progress-tone";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { describeTaskEvent, TASK_EVENT_DOT, TASK_EVENT_TEXT } from "@/lib/task-events";
import { cn, formatElapsed, formatRelativeTime, formatSmartTime, parseUTCDate } from "@/lib/utils";
import { taskSourceLabel } from "./task-source-line";
import { NARROW_ICON_TARGET, NARROW_INLINE_TARGET, NARROW_TARGET } from "./touch-targets";

// Below this, harness-vs-recomputed divergence is rounding noise; above it,
// worth a visible warning next to the cost.
const DRIFT_HINT_THRESHOLD_PCT = 2;

// Devin bills in ACUs. Its provider meta carries the rate; this is the
// documented default.
const DEFAULT_ACU_COST_USD = 2.25;

/** Token counts without a trailing ".0": "1M", not "1.0M". */
function shortTokens(n: number): string {
  return formatTokens(n).replace(/\.0(?=[KM]$)/, "");
}

const API_KEY_LABELS: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: "OAuth",
  ANTHROPIC_API_KEY: "Anthropic",
  OPENROUTER_API_KEY: "OpenRouter",
};

/** The first time the task went to `in_progress` (a resume does not count). */
function firstStartedAt(logs: AgentLog[] | undefined): string | null {
  let first: string | null = null;
  for (const log of logs ?? []) {
    if (log.eventType !== "task_status_change" || log.newValue !== "in_progress") continue;
    if (log.oldValue === "paused") continue;
    if (!first || parseUTCDate(log.createdAt) < parseUTCDate(first)) first = log.createdAt;
  }
  return first;
}

/** "claude · stock 2.1.289 · sdk": provider, variant, version and transport. */
function harnessLine(task: TaskWithLogs): string | null {
  if (!task.provider) return null;
  const version = task.harnessVariantMeta?.version;
  const parts: string[] = [task.provider];
  if (task.harnessVariant)
    parts.push(version ? `${task.harnessVariant} ${version}` : task.harnessVariant);
  else if (version) parts.push(version);
  if (task.providerMeta && "transport" in task.providerMeta && task.providerMeta.transport) {
    parts.push(String(task.providerMeta.transport));
  }
  return parts.join(" · ");
}

interface CostStats {
  totalCost: number;
  harnessCost: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  turns: number;
  sessions: number;
  models: string[];
  costSource: SessionCost["costSource"];
}

function summarizeCosts(costs: SessionCost[] | undefined): CostStats | null {
  if (!costs || costs.length === 0) return null;
  const sum = (pick: (c: SessionCost) => number) => costs.reduce((acc, c) => acc + pick(c), 0);
  const hasHarnessCosts = costs.every((c) => c.harnessCostUsd != null);
  // One source for the aggregate. When the rows disagree, show `harness`,
  // the weakest claim, so the badge never overstates precision.
  const sources = new Set(costs.map((c) => c.costSource));
  return {
    totalCost: sum((c) => c.totalCostUsd),
    harnessCost: hasHarnessCosts ? sum((c) => c.harnessCostUsd ?? 0) : null,
    inputTokens: sum((c) => c.inputTokens),
    outputTokens: sum((c) => c.outputTokens),
    cacheReadTokens: sum((c) => c.cacheReadTokens),
    cacheWriteTokens: sum((c) => c.cacheWriteTokens ?? 0),
    durationMs: sum((c) => c.durationMs),
    turns: sum((c) => c.numTurns ?? 0),
    sessions: costs.length,
    models: [...new Set(costs.map((c) => c.model))],
    costSource: sources.size === 1 ? Array.from(sources)[0] : "harness",
  };
}

/**
 * Run time: the harness's own measure when cost rows exist, otherwise the
 * wall clock from start to finish.
 */
function runTime(task: TaskWithLogs, stats: CostStats | null): string | null {
  if (stats && stats.durationMs > 0) return formatDurationMs(stats.durationMs);
  if (!task.finishedAt) return null;
  return formatElapsed(firstStartedAt(task.logs) ?? task.createdAt, task.finishedAt);
}

/** The rail's run time, for other places on the page that name it. */
export function taskRunTime(task: TaskWithLogs, costs: SessionCost[] | undefined): string | null {
  return runTime(task, summarizeCosts(costs));
}

/** "26 turns". Devin bills in ACUs and has no turn count. */
function turnsText(task: TaskWithLogs, stats: CostStats): string | null {
  if (task.provider === "devin" || stats.turns <= 0) return null;
  return `${stats.turns.toLocaleString()} ${stats.turns === 1 ? "turn" : "turns"}`;
}

/**
 * The cost, run time and turns of the Summary section, as text. The log's end
 * line shows the same text, so the page has one source for these numbers.
 * `null` when the task has no cost rows: the end line then shows the harness
 * result's numbers.
 */
export function taskRunSummary(
  task: TaskWithLogs,
  costs: SessionCost[] | undefined,
): EndSummary | null {
  const stats = summarizeCosts(costs);
  if (!stats) return null;
  return {
    cost: formatCost(stats.totalCost, { precision: 2 }),
    duration: runTime(task, stats) ?? undefined,
    turns: turnsText(task, stats) ?? undefined,
  };
}

// RailSection and RailRow are local on purpose. `DetailPageSection` and
// `QuickStat` (`components/ui/detail-page-layout.tsx`) draw their heading as
// an h4 at 10 px: under the Floor Rule's 11 px, and out of this page's h1 to
// h2 order. DESIGN.md §3 names this exception. The shared primitives keep
// their style on the other detail pages.

/** A rail section: a quiet uppercase heading over its rows. */
function RailSection({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-2", className)}>
      <h2 className="text-meta font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** One label and value. Labels are 12 px; values are 13 px. */
function RailRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  /** Machine values (times, ids, tokens, money) use mono with tabular digits. */
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn("min-w-0 break-words text-data leading-5", mono && "font-mono tabular-nums")}
      >
        {children}
      </dd>
    </div>
  );
}

/** A long id, middle-truncated, with a copy button. */
function CopyableId({
  value,
  label,
  children,
}: {
  value: string;
  label: string;
  children?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 flex-1">
        {children ?? <MiddleTruncation className="font-mono">{value}</MiddleTruncation>}
      </span>
      <CopyValueButton
        value={value}
        label={label}
        size="icon-xs"
        className={cn("shrink-0 text-muted-foreground hover:text-foreground", NARROW_ICON_TARGET)}
      />
    </span>
  );
}

/**
 * Task events in words ("Started by Lead", never `pending → in_progress`).
 * `agentNameFor` names the agent an event is about.
 */
function ActivityTimeline({
  logs,
  agentNameFor,
}: {
  logs: AgentLog[];
  agentNameFor: (log: AgentLog) => string | null;
}) {
  return (
    <ol>
      {logs.map((log, i) => {
        const event = describeTaskEvent(log, agentNameFor(log));
        return (
          <li key={log.id} className="flex gap-3">
            {/* A 1px line joins the status-colored dots. */}
            <div className="flex flex-col items-center">
              <div
                className={cn("mt-1.5 size-2 shrink-0 rounded-full", TASK_EVENT_DOT[event.tone])}
              />
              {i < logs.length - 1 && <div className="mt-0.5 w-px flex-1 bg-border" />}
            </div>
            <div className="min-w-0 pb-3">
              <p
                className={cn(
                  "text-data leading-5",
                  TASK_EVENT_TEXT[event.tone],
                  event.tone === "muted" ? "line-clamp-2" : "font-medium",
                )}
              >
                {event.label}
              </p>
              {event.detail ? (
                <p className="truncate text-xs text-muted-foreground">{event.detail}</p>
              ) : null}
              <p className="text-xs tabular-nums text-muted-foreground">
                {formatRelativeTime(log.createdAt)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ContextSection({
  task,
  context,
  isLoading,
  costs,
}: {
  task: TaskWithLogs;
  context: TaskContextResponse | undefined;
  isLoading: boolean;
  costs: CostStats | null;
}) {
  if (task.provider === "devin") {
    const meta = task.providerMeta as DevinProviderMeta | undefined;
    const maxAcuLimit = meta?.maxAcuLimit;
    if (!maxAcuLimit) return null;
    const acus = (costs?.totalCost ?? 0) / (meta?.acuCostUsd ?? DEFAULT_ACU_COST_USD);
    const percent = Math.min((acus / maxAcuLimit) * 100, 100);
    return (
      <RailSection title="ACU budget">
        <ContextBar percent={percent} label="ACU budget used" />
        <p className="font-mono text-data tabular-nums">
          {acus.toFixed(2)} of {maxAcuLimit} ACUs
        </p>
      </RailSection>
    );
  }

  if (isLoading) {
    return (
      <RailSection title="Context">
        <Skeleton className="h-1.5 w-full rounded-full" />
        <Skeleton className="h-3 w-32" />
      </RailSection>
    );
  }

  if (!context || context.summary.snapshotCount === 0) return null;

  const { summary } = context;
  const latest = findLatestUsableContextSnapshot(context.snapshots);
  const peak =
    summary.peakContextPercent != null ? `peak ${summary.peakContextPercent.toFixed(0)}%` : null;

  return (
    <RailSection title="Context">
      {latest ? <ContextBar percent={latest.contextPercent} label="Context used" /> : null}
      <p className="flex items-baseline justify-between gap-3 font-mono text-data tabular-nums">
        {latest ? (
          <span>
            {shortTokens(latest.contextUsedTokens)} of {shortTokens(latest.contextTotalTokens)}{" "}
            tokens
          </span>
        ) : (
          <span className="font-sans text-muted-foreground">Unavailable</span>
        )}
        {peak ? <span className="text-muted-foreground">{peak}</span> : null}
      </p>
      {summary.compactionCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {summary.compactionCount === 1
            ? "Compacted once"
            : `Compacted ${summary.compactionCount} times`}
        </p>
      ) : null}
    </RailSection>
  );
}

function ContextBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Progress
        value={percent}
        aria-label={label}
        className={cn("h-1.5 flex-1", progressBarTone(percent))}
      />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {percent.toFixed(0)}%
      </span>
    </div>
  );
}

function SourceControlSection({ task }: { task: TaskWithLogs }) {
  if (!(task.vcsProvider || task.vcsRepo || task.vcsUrl || task.vcsEventType || task.vcsAuthor)) {
    return null;
  }
  return (
    <RailSection title="Source control">
      <div className="space-y-2 rounded-md border border-border px-3 py-2.5">
        {/* Row 1: provider icon and repo. The author is on row 2, so a long
            repo name is not truncated. */}
        <div className="flex min-w-0 items-center gap-2">
          {task.vcsProvider === "github" ? (
            <Github className="size-4 shrink-0" />
          ) : task.vcsProvider === "gitlab" ? (
            <Gitlab className="size-4 shrink-0" />
          ) : task.vcsProvider ? (
            <Link2 className="size-4 shrink-0" />
          ) : null}
          {task.vcsRepo && (
            <span className="truncate font-mono text-xs text-foreground" title={task.vcsRepo}>
              {task.vcsRepo}
            </span>
          )}
        </div>
        {/* Row 2: PR or MR link, then the author. */}
        {(task.vcsUrl || task.vcsAuthor) && (
          <div className="flex min-w-0 items-center gap-3">
            {task.vcsUrl && task.vcsNumber && (
              <a
                href={task.vcsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex shrink-0 items-center gap-1.5 text-xs text-primary hover:underline",
                  NARROW_TARGET,
                )}
              >
                <GitPullRequest className="size-3.5 shrink-0" />
                <span className="font-mono">#{task.vcsNumber}</span>
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
              </a>
            )}
            {task.vcsUrl && !task.vcsNumber && (
              <a
                href={task.vcsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs text-primary hover:underline",
                  NARROW_TARGET,
                )}
              >
                <Link2 className="size-3.5 shrink-0" />
                <MiddleTruncation>{task.vcsUrl}</MiddleTruncation>
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
              </a>
            )}
            {task.vcsAuthor && (
              <span className="ml-auto flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <User className="size-3 shrink-0" />
                <span className="truncate">{task.vcsAuthor}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </RailSection>
  );
}

interface TaskDetailsRailProps {
  task: TaskWithLogs;
  /** The assignee's name, when the agents list has it. */
  agentName: string | null;
  /** The requesting user's name, when the users list has it. */
  requestedByName: string | null;
  /** Names the agent an Activity event is about. */
  agentNameFor: (log: AgentLog) => string | null;
  costs: SessionCost[] | undefined;
  costsLoading: boolean;
  context: TaskContextResponse | undefined;
  contextLoading: boolean;
}

/**
 * Everything about a task that is not its outcome or its log: who, where
 * from, when, how much, context use, the event history, and the technical
 * ids. The wide layout shows it as the right rail; the narrow layout shows it
 * in the Details tab.
 */
export function TaskDetailsRail({
  task,
  agentName,
  requestedByName,
  agentNameFor,
  costs,
  costsLoading,
  context,
  contextLoading,
}: TaskDetailsRailProps) {
  const stats = summarizeCosts(costs);
  const isTerminal = TERMINAL_STATUSES.has(task.status);
  const isDevin = task.provider === "devin";

  // A task that never started reads "Created"; one that did reads "Started".
  const startedAt = firstStartedAt(task.logs);
  const timeLabel = startedAt ? "Started" : "Created";
  const timeValue = startedAt ?? task.createdAt;
  // The run time, cost and turns use the same helpers as `taskRunSummary`
  // (the log's end line).
  const ran = runTime(task, stats);
  const turns = stats ? turnsText(task, stats) : null;

  const acuCostUsd =
    (task.providerMeta as DevinProviderMeta | undefined)?.acuCostUsd ?? DEFAULT_ACU_COST_USD;
  const acus = isDevin && stats ? stats.totalCost / acuCostUsd : null;
  const driftPercent = stats ? (costDriftPercent(stats.harnessCost, stats.totalCost) ?? 0) : 0;
  const latestSnapshot = context ? findLatestUsableContextSnapshot(context.snapshots) : undefined;
  const contextFormula =
    latestSnapshot?.contextFormula && latestSnapshot.contextFormula !== "unknown"
      ? latestSnapshot.contextFormula
      : null;
  const harness = harnessLine(task);
  const hasEvents = (task.logs?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <RailSection title="Summary">
        <dl>
          <RailRow label="Agent">
            {task.agentId ? (
              <Link
                to={`/agents/${task.agentId}`}
                className={cn("text-primary hover:underline", NARROW_INLINE_TARGET)}
              >
                {agentName ?? `${task.agentId.slice(0, 8)}…`}
              </Link>
            ) : (
              <span className="text-muted-foreground">Not assigned</span>
            )}
          </RailRow>
          {task.creatorAgentId && task.creatorAgentId !== task.agentId ? (
            <RailRow label="Created by">
              <AgentLink agentId={task.creatorAgentId} className={NARROW_INLINE_TARGET} />
            </RailRow>
          ) : null}
          {task.requestedByUserId ? (
            <RailRow label="Requested by">
              {requestedByName ?? (
                <span className="font-mono">{task.requestedByUserId.slice(0, 8)}…</span>
              )}
            </RailRow>
          ) : null}
          {task.source ? <RailRow label="Source">{taskSourceLabel(task.source)}</RailRow> : null}
          <RailRow label={timeLabel} mono>
            <span title={parseUTCDate(timeValue).toLocaleString()}>
              {formatSmartTime(timeValue)}
            </span>
            {ran ? ` · ran ${ran}` : null}
          </RailRow>
          {costsLoading ? (
            <RailRow label="Cost">
              <Skeleton className="mt-1 h-3 w-24" />
            </RailRow>
          ) : stats ? (
            <RailRow label="Cost" mono>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the tooltip, so keyboard users can read the exact cost
                    tabIndex={0}
                    className={cn(
                      "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      NARROW_INLINE_TARGET,
                    )}
                  >
                    {formatCost(stats.totalCost, { precision: 2 })}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {formatCost(stats.totalCost, { precision: 4 })}
                </TooltipContent>
              </Tooltip>
              {acus != null ? ` · ${acus.toFixed(2)} ACUs` : turns ? ` · ${turns}` : null}
              {stats.sessions > 1 ? ` · ${stats.sessions} sessions` : null}
            </RailRow>
          ) : null}
        </dl>
      </RailSection>

      <SourceControlSection task={task} />

      {task.dependsOn && task.dependsOn.length > 0 ? (
        <RailSection
          title={
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="size-3" />
              Dependencies ({task.dependsOn.length})
            </span>
          }
        >
          <ul className="space-y-1">
            {task.dependsOn.map((depId) => (
              <li key={depId}>
                <Link
                  to={`/tasks/${depId}`}
                  className={cn(
                    "font-mono text-data text-primary hover:underline",
                    NARROW_INLINE_TARGET,
                  )}
                >
                  #{depId.slice(0, 8)}
                </Link>
              </li>
            ))}
          </ul>
        </RailSection>
      ) : null}

      {/* The last progress line ("Running script") is stale once the task
          ends; the outcome carries the result. */}
      {task.progress && !isTerminal ? (
        <RailSection title="Progress">
          <p className="max-h-32 overflow-auto whitespace-pre-wrap text-data leading-5 text-muted-foreground">
            {task.progress}
          </p>
        </RailSection>
      ) : null}

      <ContextSection task={task} context={context} isLoading={contextLoading} costs={stats} />

      {hasEvents ? (
        <RailSection title={`Activity (${task.logs.length})`}>
          <ActivityTimeline logs={task.logs} agentNameFor={agentNameFor} />
        </RailSection>
      ) : null}

      {/* A rail section like the others: an h2 at the meta size. */}
      <CollapsibleSection
        title="Technical details"
        persistKey="tasks:technical-details-open"
        headerClassName={NARROW_TARGET}
        heading="h2"
        titleClassName="text-meta"
      >
        <dl className="pt-1">
          <RailRow label="Task id">
            <CopyableId value={task.id} label="Copy task id" />
          </RailRow>
          {task.claudeSessionId ? (
            <RailRow label="Session">
              <CopyableId value={task.claudeSessionId} label="Copy session id">
                <SessionId
                  sessionId={task.claudeSessionId}
                  provider={task.provider}
                  providerMeta={task.providerMeta}
                />
              </CopyableId>
            </RailRow>
          ) : null}
          {task.swarmVersion ? (
            <RailRow label="Version" mono>
              <span title={`agent-swarm ${task.swarmVersion} at task creation`}>
                v{task.swarmVersion}
              </span>
            </RailRow>
          ) : null}
          {task.credentialKeySuffix ? (
            <RailRow label="API key" mono>
              <Link
                to="/settings/api-keys"
                className={cn("text-primary hover:underline", NARROW_INLINE_TARGET)}
              >
                {API_KEY_LABELS[task.credentialKeyType ?? ""] ?? task.credentialKeyType ?? "Key"} …
                {task.credentialKeySuffix}
              </Link>
            </RailRow>
          ) : null}
          {harness ? (
            <RailRow label="Harness" mono>
              {harness}
            </RailRow>
          ) : null}
          {stats && stats.models.length > 0 ? (
            <RailRow label="Model" mono>
              {stats.models.join(", ")}
            </RailRow>
          ) : null}
          {stats ? (
            <RailRow label="Cost" mono>
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {formatCost(stats.totalCost, { precision: 4 })}
                <CostSourceBadge
                  source={stats.costSource}
                  harnessCostUsd={stats.harnessCost}
                  totalCostUsd={stats.totalCost}
                />
                {driftPercent > DRIFT_HINT_THRESHOLD_PCT ? (
                  <span className="text-xs text-status-warning-strong">
                    Δ {driftPercent.toFixed(1)}%
                  </span>
                ) : null}
              </span>
            </RailRow>
          ) : null}
          {stats && !isDevin ? (
            <RailRow label="Tokens" mono>
              {formatTokens(stats.inputTokens)} in · {formatTokens(stats.outputTokens)} out
            </RailRow>
          ) : null}
          {stats && !isDevin && (stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) ? (
            <RailRow label="Cache" mono>
              {formatTokens(stats.cacheReadTokens)} read · {formatTokens(stats.cacheWriteTokens)}{" "}
              write
            </RailRow>
          ) : null}
          {contextFormula ? (
            <RailRow label="Context formula" mono>
              {contextFormula}
            </RailRow>
          ) : null}
          {task.finishedAt ? (
            <RailRow label="Finished" mono>
              <span title={parseUTCDate(task.finishedAt).toLocaleString()}>
                {formatSmartTime(task.finishedAt)}
              </span>
            </RailRow>
          ) : null}
          {task.parentTaskId ? (
            <RailRow label="Parent" mono>
              <Link
                to={`/tasks/${task.parentTaskId}`}
                className={cn("text-primary hover:underline", NARROW_INLINE_TARGET)}
              >
                #{task.parentTaskId.slice(0, 8)}
              </Link>
            </RailRow>
          ) : null}
          {task.dir ? (
            <RailRow label="Dir">
              <MiddleTruncation className="font-mono">{task.dir}</MiddleTruncation>
            </RailRow>
          ) : null}
          {task.workflowRunId ? (
            <RailRow label="Workflow" mono>
              <Link
                to={`/workflow-runs/${task.workflowRunId}`}
                className={cn("text-primary hover:underline", NARROW_INLINE_TARGET)}
              >
                #{task.workflowRunId.slice(0, 8)}
              </Link>
            </RailRow>
          ) : null}
          {task.taskType ? (
            <RailRow label="Type" mono>
              {task.taskType}
            </RailRow>
          ) : null}
          {task.priority !== undefined ? (
            <RailRow label="Priority" mono>
              P{task.priority}
            </RailRow>
          ) : null}
          {task.source ? (
            <RailRow label="Source" mono>
              {task.source}
            </RailRow>
          ) : null}
          {task.effort ? (
            <RailRow label="Effort" mono>
              {task.effort}
            </RailRow>
          ) : null}
        </dl>
      </CollapsibleSection>
    </div>
  );
}
