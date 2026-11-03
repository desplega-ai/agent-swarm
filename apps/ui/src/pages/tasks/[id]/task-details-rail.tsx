import { openAICompatibleProviders, providerKeyVars } from "@desplega/model-catalog";
import { ExternalLink, Github, Gitlab, GitPullRequest, Link2, User } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  AgentLog,
  DevinProviderMeta,
  SessionCost,
  TaskContextResponse,
  TaskWithLogs,
} from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { AgentLink } from "@/components/shared/agent-link";
import { BitbucketMark } from "@/components/shared/bitbucket-mark";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { CostSourceBadge, costDriftPercent } from "@/components/shared/cost-source-badge";
import { EffortMark } from "@/components/shared/effort-mark";
import { RelativeTime } from "@/components/shared/relative-time";
import { SessionId } from "@/components/shared/session-id";
import { TaskAttachmentsSection } from "@/components/shared/task-attachments-section";
import { TaskSourceMark, taskSourceLabel } from "@/components/shared/task-source-mark";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRevealText } from "@/hooks/use-reveal-text";
import { findLatestUsableContextSnapshot } from "@/lib/context-display";
import { formatCost } from "@/lib/cost-format";
import { formatDurationMs } from "@/lib/format-duration-ms";
import { formatTokens } from "@/lib/format-tokens";
import { progressBarTone } from "@/lib/percent-progress-tone";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { taskDisplayEffort } from "@/lib/task-model-resolution";
import { cn, formatElapsed, formatSmartTime, parseUTCDate } from "@/lib/utils";
import type { CallUsageTotals } from "@/logs-parser";
import { type RailComposition, RequestCompositionSection } from "./request-composition-section";
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
  // OpenAI-compatible registry providers, canonical key and aliases.
  ...Object.fromEntries(
    openAICompatibleProviders().flatMap((p) =>
      providerKeyVars(p).map((name) => [name, p.displayName]),
    ),
  ),
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

/** The rail's total cost in USD, for the header chip. Null without cost rows. */
export function taskTotalCost(costs: SessionCost[] | undefined): number | null {
  return summarizeCosts(costs)?.totalCost ?? null;
}

/** "26 turns". Devin bills in ACUs and has no turn count. */
function turnsText(task: TaskWithLogs, stats: CostStats): string | null {
  if (task.provider === "devin" || stats.turns <= 0) return null;
  return `${stats.turns.toLocaleString()} ${stats.turns === 1 ? "turn" : "turns"}`;
}

// RailSection and RailRow are local on purpose. `DetailPageSection` and
// `QuickStat` (`components/ui/detail-page-layout.tsx`) draw their heading as
// an h4 at 10 px: under the Floor Rule's 11 px, and out of this page's h1 to
// h2 order. DESIGN.md §3 names this exception. The shared primitives keep
// their style on the other detail pages.

/** The card's padding for each section, and for the collapsible ones. */
const SECTION_PAD = "px-4 py-3";

/** A collapsible section's title, in the same style as a section heading. */
const SECTION_TOGGLE_TITLE = "text-meta font-medium normal-case tracking-normal";

/**
 * A card section: a quiet heading over its rows. The card draws a hairline
 * between sections. `hideTitle` keeps the heading for screen readers only
 * (the first section, as in T3 Code's details card).
 */
function RailSection({
  title,
  children,
  hideTitle = false,
}: {
  title: ReactNode;
  children: ReactNode;
  hideTitle?: boolean;
}) {
  return (
    <section className={SECTION_PAD}>
      <h2
        className={cn(
          "mb-1.5 flex items-center gap-1.5 text-meta font-medium text-muted-foreground",
          hideTitle && "sr-only",
        )}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * One label and value. Labels are 12 px; values are 13 px. Centered: an
 * agent's avatar and a 44 px narrow link have no text baseline to align to.
 * In the narrow layout every row is 44 px tall, as its links are, so the
 * rows keep one rhythm.
 */
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
    <div
      className={cn(
        "grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 py-1 @max-[60rem]:py-0",
        NARROW_TARGET,
      )}
    >
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

function ContextSection({
  task,
  context,
  isLoading,
  costs,
  callUsage,
}: {
  task: TaskWithLogs;
  context: TaskContextResponse | undefined;
  isLoading: boolean;
  costs: CostStats | null;
  callUsage: CallUsageTotals | null;
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

  const hasSnapshots = !!context && context.summary.snapshotCount > 0;
  if (!hasSnapshots && !callUsage) return null;

  const summary = context?.summary;
  const latest = context ? findLatestUsableContextSnapshot(context.snapshots) : undefined;
  const peak =
    summary?.peakContextPercent != null ? `peak ${summary.peakContextPercent.toFixed(0)}%` : null;

  return (
    <RailSection title="Context">
      {hasSnapshots ? (
        <>
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
          {summary && summary.compactionCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {summary.compactionCount === 1
                ? "Compacted once"
                : `Compacted ${summary.compactionCount} times`}
            </p>
          ) : null}
        </>
      ) : null}
      {callUsage ? <CacheHitRow totals={callUsage} /> : null}
    </RailSection>
  );
}

/** Σ cache read / Σ prompt tokens over the session log's LLM calls. */
function CacheHitRow({ totals }: { totals: CallUsageTotals }) {
  const calls = `${totals.calls} ${totals.calls === 1 ? "call" : "calls"}`;
  return (
    <p className="flex items-baseline justify-between gap-3 font-mono text-data tabular-nums">
      <span>
        <span className="font-sans text-muted-foreground">Cache hit </span>
        {totals.cacheReported && totals.ratio !== null
          ? `${Math.floor(totals.ratio * 100)}%`
          : "no cache reported"}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-muted-foreground">{calls}</span>
        </TooltipTrigger>
        <TooltipContent className="font-mono tabular-nums">
          {shortTokens(totals.cacheReadTokens)} read of {shortTokens(totals.promptTokens)} prompt
          tokens
        </TooltipContent>
      </Tooltip>
    </p>
  );
}

function ContextBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Progress
        value={percent}
        aria-label={label}
        className={cn("h-1 flex-1", progressBarTone(percent))}
      />
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {percent.toFixed(0)}%
      </span>
    </div>
  );
}

/**
 * The repo's page: the PR or issue URL up to the repo path (it keeps a
 * self-hosted GitLab's host). Without a URL only GitHub has a known host;
 * GitLab and Bitbucket can be self-hosted, so their repo stays plain text.
 */
function repoUrl(task: TaskWithLogs): string | null {
  if (!task.vcsRepo) return null;
  const at = task.vcsUrl?.indexOf(`/${task.vcsRepo}`) ?? -1;
  if (task.vcsUrl && at > 0) return task.vcsUrl.slice(0, at + task.vcsRepo.length + 1);
  return task.vcsProvider === "github" ? `https://github.com/${task.vcsRepo}` : null;
}

function SourceControlSection({ task }: { task: TaskWithLogs }) {
  if (!(task.vcsProvider || task.vcsRepo || task.vcsUrl || task.vcsEventType || task.vcsAuthor)) {
    return null;
  }
  const repoHref = repoUrl(task);
  return (
    <RailSection title="Source control">
      <div className="space-y-1.5 py-1">
        {/* Row 1: provider icon and repo. The author is on row 2, so a long
            repo name is not truncated. */}
        <div className="flex min-w-0 items-center gap-2">
          {task.vcsProvider === "github" ? (
            <Github className="size-4 shrink-0" />
          ) : task.vcsProvider === "gitlab" ? (
            <Gitlab className="size-4 shrink-0" />
          ) : task.vcsProvider === "bitbucket" ? (
            <BitbucketMark className="size-4 shrink-0" />
          ) : task.vcsProvider ? (
            <Link2 className="size-4 shrink-0" />
          ) : null}
          {task.vcsRepo && repoHref ? (
            <a
              href={repoHref}
              target="_blank"
              rel="noopener noreferrer"
              title={task.vcsRepo}
              className={cn(
                "flex min-w-0 items-center gap-1.5 font-mono text-xs text-primary hover:underline",
                NARROW_TARGET,
              )}
            >
              <span className="truncate">{task.vcsRepo}</span>
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
            </a>
          ) : task.vcsRepo ? (
            <span className="truncate font-mono text-xs text-foreground" title={task.vcsRepo}>
              {task.vcsRepo}
            </span>
          ) : null}
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
  costs: SessionCost[] | undefined;
  costsLoading: boolean;
  context: TaskContextResponse | undefined;
  contextLoading: boolean;
  /** Per-call usage parsed from the session log the page already loads. */
  callUsage?: CallUsageTotals | null;
  /** The latest session's request composition, with usage details on. */
  composition?: RailComposition | null;
  /** The session this task belongs to, when the caller can open it. */
  session?: { href: string; title: string } | null;
  className?: string;
}

/**
 * Everything about a task that is not its outcome or its log: who, where
 * from, when, how much, its files, context use, and the technical ids. One
 * card of sections, after T3 Code's thread details card. The wide layout
 * shows it next to the column; the narrow layout shows it in the Details tab.
 */
/**
 * A poll lands a whole new progress line; reveal it word by word while the
 * task runs. Its own component, so each reveal step re-renders only the line.
 */
function RevealedText({ text, live }: { text: string; live: boolean }) {
  return useRevealText(text, live);
}

export function TaskDetailsRail({
  task,
  agentName,
  requestedByName,
  costs,
  costsLoading,
  context,
  contextLoading,
  callUsage = null,
  composition = null,
  session = null,
  className,
}: TaskDetailsRailProps) {
  const stats = summarizeCosts(costs);
  const isTerminal = TERMINAL_STATUSES.has(task.status);
  const isDevin = task.provider === "devin";

  // A task that never started reads "Created"; one that did reads "Started".
  const startedAt = firstStartedAt(task.logs);
  const timeLabel = startedAt ? "Started" : "Created";
  const timeValue = startedAt ?? task.createdAt;
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
  const fileCount = task.attachments?.length ?? 0;

  return (
    <div
      className={cn(
        "divide-y divide-border-subtle rounded-xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <RailSection title="Summary" hideTitle>
        <dl>
          <RailRow label="Agent">
            {task.agentId ? (
              <Link
                to={`/agents/${task.agentId}`}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 text-primary hover:underline",
                  NARROW_INLINE_TARGET,
                )}
              >
                <AgentAvatar
                  agentId={task.agentId}
                  agentName={agentName}
                  size="xs"
                  className="size-4.5 shadow-none"
                />
                <span className="truncate">{agentName ?? `${task.agentId.slice(0, 8)}…`}</span>
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
          {/* The task that started this one. The page's transcript lists the
              tasks this one started. */}
          {task.parentTaskId ? (
            <RailRow label="Parent task" mono>
              <Link
                to={`/tasks/${task.parentTaskId}`}
                className={cn("text-primary hover:underline", NARROW_INLINE_TARGET)}
              >
                #{task.parentTaskId.slice(0, 8)}
              </Link>
            </RailRow>
          ) : null}
          {session ? (
            <RailRow label="Session">
              <Link
                to={session.href}
                className={cn(
                  "inline-flex max-w-full items-center text-primary hover:underline",
                  NARROW_INLINE_TARGET,
                )}
              >
                <span className="truncate">{session.title}</span>
              </Link>
            </RailRow>
          ) : null}
          {task.requestedByUserId ? (
            <RailRow label="Requested by">
              {requestedByName ?? (
                <span className="font-mono">{task.requestedByUserId.slice(0, 8)}…</span>
              )}
            </RailRow>
          ) : null}
          {task.source ? (
            <RailRow label="Source">
              <span className="inline-flex items-center gap-1.5">
                <TaskSourceMark source={task.source} className="text-muted-foreground" />
                {taskSourceLabel(task.source)}
              </span>
            </RailRow>
          ) : null}
          <RailRow label={timeLabel} mono>
            <RelativeTime at={timeValue}>{formatSmartTime(timeValue)}</RelativeTime>
          </RailRow>
          {ran ? (
            <RailRow label="Duration" mono>
              {ran}
            </RailRow>
          ) : null}
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

      {fileCount > 0 ? (
        <RailSection
          title={
            <>
              Files
              <span className="font-mono tabular-nums">{fileCount}</span>
            </>
          }
        >
          <TaskAttachmentsSection
            taskId={task.id}
            attachments={task.attachments}
            variant="plain"
            className="-mx-2"
          />
        </RailSection>
      ) : null}

      {task.dependsOn && task.dependsOn.length > 0 ? (
        <RailSection
          title={
            <>
              Dependencies
              <span className="font-mono tabular-nums">{task.dependsOn.length}</span>
            </>
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
            <RevealedText text={task.progress} live={!isTerminal} />
          </p>
        </RailSection>
      ) : null}

      <ContextSection
        task={task}
        context={context}
        isLoading={contextLoading}
        costs={stats}
        callUsage={callUsage}
      />

      {composition ? (
        <RequestCompositionSection
          composition={composition}
          className={SECTION_PAD}
          titleClassName={SECTION_TOGGLE_TITLE}
        />
      ) : null}

      {/* A card section like the others: an h2 at the meta size. */}
      <CollapsibleSection
        title="Technical details"
        persistKey="tasks:technical-details-open"
        className={SECTION_PAD}
        headerClassName={NARROW_TARGET}
        heading="h2"
        titleClassName={SECTION_TOGGLE_TITLE}
      >
        <dl className="pt-1">
          <RailRow label="Task id">
            <CopyableId value={task.id} label="Copy task id" />
          </RailRow>
          {task.claudeSessionId ? (
            <RailRow label="Harness session">
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
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {stats.models.join(", ")}
                <EffortMark effort={taskDisplayEffort(task)} className="text-muted-foreground" />
              </span>
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
              <RelativeTime at={task.finishedAt}>{formatSmartTime(task.finishedAt)}</RelativeTime>
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
        </dl>
      </CollapsibleSection>
    </div>
  );
}
