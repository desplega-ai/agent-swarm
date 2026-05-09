/**
 * Sessions surface — single agent turn rendered inside the session timeline.
 *
 * No outer card chrome. Each turn is a flex row composed of:
 *   - An <AgentAvatar> that visually sits on the timeline spine (rendered by
 *     <SessionTimeline>) — it shares the spine's left coordinate via z-index.
 *   - A content column with a single header line (agent name · time · status
 *     when not completed · hover actions) and the agent's output rendered as
 *     Streamdown markdown directly (no nested border).
 *
 * The tinted "outcome block" only survives for `failed` / `cancelled` turns —
 * those genuinely benefit from a colored frame; success doesn't.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, GitBranch, Maximize2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { useAgent } from "@/api/hooks/use-agents";
import type { AgentTask, SessionLog } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn, formatRelativeTime, normalizeNewlines } from "@/lib/utils";
import { ChainOfThought } from "./chain-of-thought";
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
  className,
}: TaskCardProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
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
        className={cn(
          "group relative flex gap-3 min-w-0",
          insideParallelGroup ? "pl-4 pb-5" : "pb-7",
          className,
        )}
      >
        {/* Per-row spine fragment — only on top-level rows (parallel groups
            draw their own dashed sub-spine). Each row's spine spans top to
            bottom, so adjacent rows form a continuous line via touching
            paddings. The line is hidden behind the avatar by `ring-4
            ring-background` on the avatar. */}
        {insideParallelGroup ? null : (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 left-3.5 w-px bg-border/70"
          />
        )}
        <AgentAvatar
          agentId={task.agentId}
          agentName={agent?.name}
          size={insideParallelGroup ? "sm" : "md"}
          className={cn(
            "relative z-10 mt-0.5 shrink-0",
            insideParallelGroup ? "ring-2 ring-background" : "ring-4 ring-background",
            isRunning && "ring-primary/40 animate-pulse",
          )}
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
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setOpen(true)}
                className="h-6 w-6"
                title="Open task details"
                aria-label="Open task details"
              >
                <Maximize2 className="h-3 w-3" />
              </Button>
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
      <span
        className={cn(
          "block whitespace-pre-wrap",
          !expanded && isLong && "line-clamp-3",
        )}
      >
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
      <Button
        size="icon"
        variant="ghost"
        onClick={() => copy(trimmed)}
        className="absolute top-0 right-0 h-6 w-6 opacity-70 md:opacity-0 md:group-hover/outcome:opacity-70 hover:opacity-100 transition-opacity"
        title={copied ? "Copied" : "Copy output"}
        aria-label={copied ? "Copied" : "Copy output to clipboard"}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
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
        <Button
          size="icon"
          variant="ghost"
          onClick={() => copy(trimmed)}
          className="h-6 w-6 -mr-1 opacity-60 hover:opacity-100"
          title={copied ? "Copied" : "Copy"}
          aria-label={copied ? "Copied" : "Copy to clipboard"}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
      <div className="text-xs min-w-0 break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full text-status-error-strong">
        <Streamdown>{normalizeNewlines(trimmed)}</Streamdown>
      </div>
    </div>
  );
}

export interface ParallelGroupProps {
  count: number;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps sibling turns that share a parent into a visually distinct branched
 * sub-tree: a labelled header chip + an indented dashed sub-spine. Children
 * leave the main spine and sit on the sub-spine via `insideParallelGroup`
 * (smaller avatars + thinner ring).
 *
 * Default expanded for ≤3 children; collapsed for 4+ (otherwise large
 * fan-outs bury the rest of the timeline).
 */
export function ParallelGroup({ count, children, className }: ParallelGroupProps) {
  const [expanded, setExpanded] = useState<boolean>(count <= 3);
  return (
    <div data-slot="session-parallel-group" className={cn("relative ml-9", className)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border",
          "text-[10px] uppercase tracking-wider font-mono font-medium",
          "bg-muted/60 text-foreground/80 hover:bg-muted transition-colors",
        )}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} parallel group of ${count} tasks`}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <GitBranch className="h-3 w-3 text-primary" />
        <span>{count} in parallel</span>
      </button>
      {expanded ? (
        <div className="mt-3 pl-4 border-l-2 border-dashed border-border/70 flex flex-col gap-4 py-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}
