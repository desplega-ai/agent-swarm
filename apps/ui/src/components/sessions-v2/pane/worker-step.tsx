import { ChevronDown, Maximize2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import type { AgentTask } from "@/api/types";
import { ChainOfThought } from "@/components/sessions/chain-of-thought";
import { TaskDetailSheet } from "@/components/sessions/task-detail-sheet";
import { TaskOutcome } from "@/components/sessions/task-outcome";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { messageActionClass } from "@/components/shared/message-copy-button";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTaskSheetParam } from "@/hooks/use-task-sheet-param";
import { formatSpan } from "@/lib/format-duration-ms";
import { type JsonContainer, parseJsonOutput } from "@/lib/json-output";
import { markdownPreview } from "@/lib/markdown-preview";
import { promptTitle } from "@/lib/prompt-display";
import type { WorkerStep as Step } from "@/lib/session-turns";
import { plural } from "@/lib/sessions-v2";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { cn, normalizeNewlines } from "@/lib/utils";
import { MessageTime } from "./swarm-reply";

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/**
 * "done", "failed 2 times, then done", "retried once, then done" (an earlier
 * try was cancelled or superseded, not failed), "working", "failed",
 * "cancelled". The row shows the time on its own.
 */
function statusText(step: Step): string {
  const last = step.tries[step.tries.length - 1];
  const earlier = step.tries.slice(0, -1);
  const before = earlier.length
    ? earlier.every((attempt) => attempt.status === "failed")
      ? `failed ${times(earlier.length)}`
      : `retried ${times(earlier.length)}`
    : "";
  if (last.status === "completed") return before ? `${before}, then done` : "done";
  if (last.status === "failed") {
    return earlier.every((attempt) => attempt.status === "failed") && earlier.length
      ? `failed ${times(step.tries.length)}`
      : before
        ? `${before}, then failed`
        : "failed";
  }
  if (TERMINAL_STATUSES.has(last.status))
    return before ? `${before}, then ${last.status}` : last.status;
  if (last.status === "in_progress") return before ? `${before}, running again` : "working";
  return before ? `${before}, queued again` : "queued";
}

/** Fields a person reads first in a structured output. */
const LEAD_KEYS = ["summary", "result", "message", "status", "title"];

/** A GitHub PR or issue URL as "PR #2589" or "Issue #12", another URL as its host and path tail. */
function shortUrl(value: string): string | null {
  if (!/^https?:\/\/\S+$/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const github = /^\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/.exec(url.pathname);
  if (url.hostname === "github.com" && github) {
    return `${github[1] === "pull" ? "PR" : "Issue"} #${github[2]}`;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const tail = parts.at(-1);
  if (!tail) return url.hostname;
  return `${url.hostname}/${parts.length > 1 ? "…/" : ""}${tail}`;
}

/**
 * A structured output as "result: Approved · pr: PR #2589 · files: 3 items":
 * the human fields first, strings and array counts only. Empty when nothing
 * is left (`{}`, `[]`).
 */
function jsonLine(data: JsonContainer): string {
  if (Array.isArray(data)) return data.length > 0 ? plural(data.length, "item") : "";
  const keys = Object.keys(data);
  const ordered = [
    ...LEAD_KEYS.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !LEAD_KEYS.includes(key)),
  ];
  const fields: string[] = [];
  for (const key of ordered) {
    const value = data[key];
    if (Array.isArray(value)) fields.push(`${key}: ${plural(value.length, "item")}`);
    else if (typeof value === "string" && value.trim()) {
      fields.push(`${key}: ${shortUrl(value.trim()) ?? value.trim()}`);
    }
  }
  return fields.join(" · ");
}

/** What the preview line reads. */
type PreviewSource = Pick<AgentTask, "status" | "output" | "failureReason" | "progress" | "task">;

/** The preview reads at most this much of a text: one line never needs more. */
const PREVIEW_INPUT = 2048;

/** The start of a text, trimmed and cut to `PREVIEW_INPUT`. */
const head = (text: string | undefined) => text?.trim().slice(0, PREVIEW_INPUT) ?? "";

/**
 * The outcome as one line: the output, the failure, or the progress of open
 * work. A JSON output that the cut breaks reads as text.
 */
function outcomeLine(task: PreviewSource): string {
  const text = head(
    task.status === "completed"
      ? task.output
      : task.status === "failed" || task.status === "cancelled"
        ? task.failureReason
        : task.progress,
  );
  const json = parseJsonOutput(text);
  return json ? jsonLine(json) : text;
}

/** A bare git SHA (40 or 64 hex digits) as its first 8. */
const SHA = /\b([0-9a-f]{8})(?:[0-9a-f]{56}|[0-9a-f]{32})\b/gi;

/**
 * The row's one plain line: the outcome, else the progress (an empty
 * structured output can leave the result there), else the task's first line.
 * An open row shows the task's first line: the outcome is in full below it.
 * Capped, so the button's accessible name stays short.
 */
function preview(task: PreviewSource, open: boolean): string {
  const line = open
    ? promptTitle(task.task)
    : outcomeLine(task) || head(task.progress) || promptTitle(task.task);
  return markdownPreview(line).replace(SHA, "$1").slice(0, 300);
}

/**
 * One delegated step under a reply (SPEC R7, R8.3), as one row: the agent's
 * avatar with the status, the agent, the task type, the status, one line of
 * the outcome, and the time it took. Open work keeps its live status on the
 * closed row. A click opens the earlier tries, the last try's activity
 * (`ChainOfThought`), its output (`TaskOutcome` with its hover Copy), and a
 * footer with the start time and the details sheet.
 */
export function WorkerStep({
  step,
  agentName,
  now,
  onToggle,
}: {
  step: Step & { agentId: string | null };
  agentName: string;
  /** The timeline clock: a running step's time counts up to it. */
  now: number;
  /** Called after a person opens or closes the row. */
  onToggle?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const first = step.tries[0];
  const last = step.tries[step.tries.length - 1];
  const [detailsOpen, setDetailsOpen] = useTaskSheetParam(last.id);
  const earlier = step.tries.slice(0, -1);
  // The session polls every 5 s: parse and clean the outcome only when it changes.
  const { status, output, failureReason, progress, task } = last;
  const line = useMemo(
    () => preview({ status, output, failureReason, progress, task }, open),
    [status, output, failureReason, progress, task, open],
  );
  const end = TERMINAL_STATUSES.has(last.status)
    ? Date.parse(last.finishedAt ?? last.lastUpdatedAt)
    : now;
  return (
    <div data-slot="worker-step" className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setOpen((value) => !value);
          onToggle?.();
        }}
        // Phones and touch screens: a 44 px row (UX review R9).
        className="group/row hover-linger flex w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11"
      >
        <span className="relative shrink-0">
          <AgentAvatar agentId={step.agentId} agentName={agentName} size="sm" />
          {/* The status as a badge on the avatar; its disc takes the row's fill. */}
          <span className="hover-linger absolute -right-1 -bottom-1 flex rounded-full bg-background p-px transition-colors group-hover/row:bg-muted">
            <TaskStatusIcon status={last.status} className="size-3" />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 text-data font-semibold text-foreground">{agentName}</span>
            {step.taskType ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 font-mono text-meta">{step.taskType}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span
              className={cn(
                "min-w-0 truncate",
                last.status === "failed" && "text-status-error-strong",
                last.status === "in_progress" && earlier.length === 0 && "shimmer-text",
              )}
            >
              {statusText(step)}
            </span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{line}</span>
        </span>
        <span
          title={`Started ${new Date(first.createdAt).toLocaleString()}`}
          className="shrink-0 font-mono text-meta text-muted-foreground tabular-nums"
        >
          {formatSpan(end - Date.parse(first.createdAt))}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snappy",
            !open && "-rotate-90",
          )}
        />
      </button>
      <div id={bodyId}>
        <AnimatedReveal open={open} speed="fast">
          {/* Lines up with the text after the avatar. */}
          <div className="flex min-w-0 flex-col gap-1.5 pt-1 pr-1.5 pb-2 pl-10">
            {earlier.length > 0 ? (
              <ol
                aria-label="Earlier tries"
                className="flex flex-col gap-2 border-l border-border-subtle pl-2.5"
              >
                {earlier.map((attempt, index) => (
                  <li key={attempt.id} className="min-w-0">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <TaskStatusIcon status={attempt.status} className="size-3" />
                      <span
                        className={cn(
                          "font-semibold",
                          attempt.status === "failed" && "text-status-error-strong",
                        )}
                      >
                        Try {index + 1} {attempt.status}
                      </span>
                      <MessageTime at={attempt.createdAt} />
                    </div>
                    {attempt.failureReason ? (
                      <div className="mt-0.5 min-w-0 text-data break-words text-foreground">
                        <Streamdown>{normalizeNewlines(attempt.failureReason.trim())}</Streamdown>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
            <ChainOfThought taskId={last.id} status={last.status} task={last} />
            <TaskOutcome task={last} clamp />
            <div className="flex min-h-4 items-center gap-1.5 text-muted-foreground">
              <MessageTime at={first.createdAt} />
              <span className={messageActionClass(false)}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Open task details"
                      onClick={() => setDetailsOpen(true)}
                      className="text-muted-foreground hit-area [--hit-size:44px] hover:text-foreground"
                    >
                      <Maximize2 />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Open details</TooltipContent>
                </Tooltip>
              </span>
            </div>
          </div>
        </AnimatedReveal>
      </div>
      <TaskDetailSheet
        taskId={last.id}
        task={last}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </div>
  );
}
