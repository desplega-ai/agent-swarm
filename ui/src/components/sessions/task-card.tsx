/**
 * Sessions surface — single agent turn rendered inside the session timeline.
 *
 * No outer card chrome, no timeline spine. Each turn is a flex row of an
 * <AgentAvatar> + a content column with a single header line (agent name ·
 * time · status when not completed · hover actions) and the agent's output
 * rendered as Streamdown markdown directly. Vertical rhythm comes from per-
 * row `pb-*` rather than a connecting line.
 *
 * The tinted "outcome block" only survives for `failed` / `cancelled` turns —
 * those genuinely benefit from a colored frame; success doesn't.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Maximize2,
  Pause,
  Play,
  Split,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { useAgent } from "@/api/hooks/use-agents";
import { useCancelTask, usePauseTask, useResumeTask } from "@/api/hooks/use-tasks";
import type { AgentTask, SessionLog } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn, formatRelativeTime, normalizeNewlines } from "@/lib/utils";
import { ChainOfThought } from "./chain-of-thought";
import { ReviewAck } from "./review-ack";
import { TaskDetailSheet } from "./task-detail-sheet";

export interface TaskCardProps {
  task: AgentTask;
  /**
   * Suppress rendering of `task.task` in the body. Set when the timeline has
   * already rendered the prompt as a user-side bubble above this card.
   */
  hideTaskText?: boolean;
  /** `true` when rendered nested inside a <ParallelGroup>. */
  insideParallelGroup?: boolean;
  /** Parent task's agentId — used to render a "via {ParentAgent}" caption
   *  when work was delegated across agents. Set by the timeline. */
  parentAgentId?: string | null;
  /**
   * Skip rendering `<TaskOutcome>` inside the card. Used by the timeline
   * for parent tasks that finished after their direct children — the
   * outcome is rendered later, attached to the closing chip, so it lands
   * in chronological position instead of at the top of the parent's row.
   */
  deferOutput?: boolean;
  /** Hidden auto-review tasks attached to this turn — collapsed into a
   *  single muted `<ReviewAck>` chip below the outcome. */
  reviewAcks?: AgentTask[];
  className?: string;
}

function summarizeLog(log: SessionLog): string | null {
  const firstLine = log.content.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  if (trimmed.includes("tool_use_id") || trimmed.includes("tool_result")) return null;
  return trimmed.slice(0, 160);
}

const SHOW_STATUS_PILL = new Set<string>([
  "in_progress",
  "pending",
  "failed",
  "cancelled",
  "paused",
  "reviewing",
  "offered",
  "backlog",
  "unassigned",
]);

export function TaskCard({
  task,
  hideTaskText,
  insideParallelGroup,
  parentAgentId,
  deferOutput,
  reviewAcks,
  className,
}: TaskCardProps) {
  const queryClient = useQueryClient();

  // Sheet open-state lives in the URL (`?task=<id>`) so links to a session
  // with a particular task expanded are shareable. `replace: true` keeps the
  // back button useful — opening/closing sheets doesn't litter history.
  const [searchParams, setSearchParams] = useSearchParams();
  const open = searchParams.get("task") === task.id;
  const setOpen = useCallback(
    (next: boolean) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next) sp.set("task", task.id);
          else if (sp.get("task") === task.id) sp.delete("task");
          return sp;
        },
        { replace: true },
      );
    },
    [setSearchParams, task.id],
  );

  const cancelTask = useCancelTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();

  const isTerminal =
    task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  const canCancel = !isTerminal && task.status !== "paused";
  const canPause = task.status === "in_progress";
  const canResume = task.status === "paused";

  const { data: agent } = useAgent(task.agentId ?? "");
  const showDelegation = !!parentAgentId && !!task.agentId && parentAgentId !== task.agentId;
  const { data: parentAgent } = useAgent(showDelegation ? (parentAgentId ?? "") : "");

  const cachedLogs = queryClient.getQueryData<SessionLog[]>(["task", task.id, "session-logs"]);
  const summaryLines = useMemo(() => {
    if (!cachedLogs || cachedLogs.length === 0) return [] as string[];
    return cachedLogs
      .slice(-4)
      .map(summarizeLog)
      .filter((s): s is string => s !== null && s.length > 0)
      .slice(-2);
  }, [cachedLogs]);

  const showPill = SHOW_STATUS_PILL.has(task.status);
  const isRunning = task.status === "in_progress";
  const agentDisplay =
    agent?.name ?? (task.agentId ? `${task.agentId.slice(0, 8)}…` : "Unassigned");

  return (
    <>
      <article
        data-slot="session-task-card"
        className={cn("group flex gap-3 min-w-0", insideParallelGroup ? "pb-4" : "pb-6", className)}
      >
        <AgentAvatar
          agentId={task.agentId}
          agentName={agent?.name}
          size="md"
          className={cn("mt-0.5 shrink-0", isRunning && "ring-2 ring-primary/40 animate-pulse")}
        />
        <div className="flex-1 min-w-0 flex flex-col gap-1.5 pb-1">
          <header className="flex items-center gap-2 min-w-0 text-xs">
            {task.agentId ? (
              <Link
                to={`/agents/${task.agentId}`}
                className="font-medium text-foreground truncate hover:text-primary hover:underline underline-offset-2"
                title={`Open ${agentDisplay}`}
              >
                {agentDisplay}
              </Link>
            ) : (
              <span className="font-medium text-muted-foreground italic truncate">Unassigned</span>
            )}
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span
              className="text-muted-foreground whitespace-nowrap"
              title={`Started ${new Date(task.createdAt).toLocaleString()}`}
            >
              {formatRelativeTime(task.createdAt)}
            </span>
            {/* Finish-time hint for terminal turns — chains can complete out
                of chronological order (a parent's review aggregates after its
                children finish), so the start time alone is misleading. */}
            {(task.status === "completed" ||
              task.status === "failed" ||
              task.status === "cancelled") &&
            task.lastUpdatedAt &&
            task.lastUpdatedAt !== task.createdAt ? (
              <>
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span
                  className="text-muted-foreground/70 whitespace-nowrap"
                  title={`Finished ${new Date(task.lastUpdatedAt).toLocaleString()}`}
                >
                  finished {formatRelativeTime(task.lastUpdatedAt)}
                </span>
              </>
            ) : null}
            {showPill ? <StatusBadge status={task.status} /> : null}
            <div className="ml-auto flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              {canCancel ? (
                <AlertDialog>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 hover:text-status-error hover:bg-status-error/10"
                          aria-label="Cancel task"
                        >
                          <Ban className="h-3 w-3" />
                        </Button>
                      </AlertDialogTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Cancel task</TooltipContent>
                  </Tooltip>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel Task</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to cancel this task? This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep Task</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() =>
                          cancelTask.mutate({ id: task.id, reason: "Cancelled from session" })
                        }
                      >
                        Cancel Task
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
              {canPause ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => pauseTask.mutate(task.id)}
                      disabled={pauseTask.isPending}
                      className="h-6 w-6"
                      aria-label="Pause task"
                    >
                      <Pause className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Pause task</TooltipContent>
                </Tooltip>
              ) : null}
              {canResume ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => resumeTask.mutate(task.id)}
                      disabled={resumeTask.isPending}
                      className="h-6 w-6"
                      aria-label="Resume task"
                    >
                      <Play className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Resume task</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setOpen(true)}
                    className="h-6 w-6"
                    aria-label="Open task details"
                  >
                    <Maximize2 className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open details</TooltipContent>
              </Tooltip>
            </div>
          </header>

          {showDelegation ? (
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground -mt-0.5">
              ↳ via {parentAgent?.name ?? `${(parentAgentId ?? "").slice(0, 8)}…`}
            </p>
          ) : null}

          {hideTaskText ? null : <TaskBrief text={task.task} />}

          {/* Activity stream — always rendered so the user keeps the
              breadcrumb of "what the agent did". Active tasks show it
              expanded with a shimmering live step; terminal tasks show a
              collapsed one-liner that expands on click. */}
          <ChainOfThought taskId={task.id} status={task.status} />

          {deferOutput ? null : <TaskOutcome task={task} fallbackLines={summaryLines} />}

          {reviewAcks && reviewAcks.length > 0 ? <ReviewAck reviews={reviewAcks} /> : null}
        </div>
      </article>

      <TaskDetailSheet taskId={task.id} task={task} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * The "brief" rendered for non-user-typed turns — Lead-spawned subtasks
 * etc. Renders inside a left-rule blockquote in italic muted text. Long
 * briefs (>3 visual lines) clamp by default with a Show more / Show less
 * toggle so the timeline doesn't drown in delegation prompts.
 */
function TaskBrief({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // Cheap "is long" heuristic — line-clamp can't tell us itself without DOM
  // measurement, so trigger the toggle for either ≥3 newlines or ≥240 chars.
  const isLong = text.length > 240 || text.split("\n").length > 3;
  return (
    <blockquote className="border-l-2 border-border pl-3 py-0.5 text-xs text-muted-foreground italic min-w-0 break-words">
      <span className={cn("block whitespace-pre-wrap", !expanded && isLong && "line-clamp-3")}>
        {text}
      </span>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="not-italic text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 hover:text-foreground transition-colors mt-1"
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </blockquote>
  );
}

export function TaskOutcome({
  task,
  fallbackLines,
}: {
  task: AgentTask;
  fallbackLines?: string[];
}) {
  fallbackLines = fallbackLines ?? [];
  if (
    (task.status === "failed" || task.status === "cancelled") &&
    task.failureReason &&
    task.failureReason.trim().length > 0
  ) {
    return (
      <OutcomeFrame
        label={task.status === "cancelled" ? "Cancelled" : "Failure"}
        text={task.failureReason}
        tone="error"
      />
    );
  }
  if (task.status === "completed" && task.output && task.output.trim().length > 0) {
    return <OutcomeProse text={task.output} />;
  }
  // The chain-of-thought above already covers active states — only fall
  // through to the cached summaryLines as a final fallback when nothing
  // else has surfaced.
  if (fallbackLines.length === 0) return null;
  return (
    <ul className="text-xs text-muted-foreground space-y-0.5 italic">
      {fallbackLines.map((line, idx) => (
        <li key={idx} className="truncate">
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * Successful output — renders inline as plain prose, no border. Hover surfaces
 * a single Copy action top-right so the chrome is invisible until needed.
 */
function OutcomeProse({ text }: { text: string }) {
  const trimmed = text.trim();
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="relative min-w-0 group/outcome">
      <div className="text-sm leading-relaxed text-foreground/85 min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full prose-chat">
        <Streamdown>{normalizeNewlines(trimmed)}</Streamdown>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => copy(trimmed)}
            className="absolute top-0 right-0 h-6 w-6 opacity-70 md:opacity-0 md:group-hover/outcome:opacity-70 hover:opacity-100 transition-opacity"
            aria-label={copied ? "Copied" : "Copy output to clipboard"}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy output"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * Tinted block — only used for failed/cancelled. Worth the chrome because the
 * negative state genuinely needs attention.
 */
function OutcomeFrame({ label, text, tone }: { label: string; text: string; tone: "error" }) {
  const trimmed = text.trim();
  const { copied, copy } = useCopyToClipboard();
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 mt-0.5 min-w-0 relative group/outcome",
        tone === "error" ? "border-status-error/30 bg-status-error/5" : "",
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-[10px] uppercase tracking-wider font-mono text-status-error-strong">
          {label}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => copy(trimmed)}
              className="h-6 w-6 -mr-1 opacity-60 hover:opacity-100"
              aria-label={copied ? "Copied" : "Copy to clipboard"}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
        </Tooltip>
      </div>
      <div className="text-xs min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full text-status-error-strong">
        <Streamdown>{normalizeNewlines(trimmed)}</Streamdown>
      </div>
    </div>
  );
}

export interface ParallelGroupProps {
  count: number;
  /** Agent that spawned the parallel children — used to render
   *  "{count} in parallel · via {Agent}" so the per-child "↳ via X"
   *  delegation hint can be suppressed. */
  parentAgentId?: string | null;
  children: React.ReactNode;
  className?: string;
}

/**
 * Quiet header above sibling turns that share a parent. Single muted line
 * — `⏵ 2 in parallel · via Lead` — clickable to collapse/expand. No chip,
 * no sub-spine; the children render at the same indent as everything else
 * and rely on the caption for the "these belong together" signal.
 *
 * Default expanded for ≤3 children; collapsed for 4+ so a large fan-out
 * doesn't bury the rest of the timeline.
 */
export function ParallelGroup({ count, parentAgentId, children, className }: ParallelGroupProps) {
  const [expanded, setExpanded] = useState<boolean>(count <= 3);
  const { data: parentAgent } = useAgent(parentAgentId ?? "");
  const parentName = parentAgent?.name ?? null;
  return (
    <div data-slot="session-parallel-group" className={cn("ml-11", className)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 mb-2",
          "text-[10px] font-mono uppercase tracking-wider",
          "text-muted-foreground/80 hover:text-foreground transition-colors",
        )}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} parallel group of ${count} tasks`}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Split className="h-3 w-3 shrink-0 text-primary/70" aria-hidden="true" />
        <span>
          {count} in parallel
          {parentName ? (
            <span className="text-muted-foreground/60"> · via {parentName}</span>
          ) : null}
        </span>
      </button>
      {expanded ? <div className="flex flex-col">{children}</div> : null}
    </div>
  );
}
