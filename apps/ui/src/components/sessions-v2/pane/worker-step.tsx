import { ChevronDown, Maximize2 } from "lucide-react";
import { useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { ChainOfThought } from "@/components/sessions/chain-of-thought";
import { TaskDetailSheet } from "@/components/sessions/task-detail-sheet";
import { TaskOutcome } from "@/components/sessions/task-outcome";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTaskSheetParam } from "@/hooks/use-task-sheet-param";
import { formatSpan } from "@/lib/format-duration-ms";
import type { WorkerStep as Step } from "@/lib/session-turns";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { cn, normalizeNewlines } from "@/lib/utils";
import { MessageTime } from "./swarm-reply";

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/**
 * "done in 4m", "failed 2 times, then done in 1h 36m", "retried once, then
 * done in 16m" (an earlier try was cancelled or superseded, not failed),
 * "working", "failed", "cancelled".
 */
function outcomeText(step: Step): string {
  const first = step.tries[0];
  const last = step.tries[step.tries.length - 1];
  const earlier = step.tries.slice(0, -1);
  const before = earlier.length
    ? earlier.every((attempt) => attempt.status === "failed")
      ? `failed ${times(earlier.length)}`
      : `retried ${times(earlier.length)}`
    : "";
  const span = formatSpan(
    Date.parse(last.finishedAt ?? last.lastUpdatedAt) - Date.parse(first.createdAt),
  );
  if (last.status === "completed")
    return before ? `${before}, then done in ${span}` : `done in ${span}`;
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

/**
 * One delegated step under a reply (SPEC R7, R8.3): the agent, the task
 * type, and the outcome. The body is the last try's activity and output
 * (`ChainOfThought`, `TaskOutcome` with its hover Copy). Earlier tries fold
 * into a list that opens in place.
 */
export function WorkerStep({ step, agentName }: { step: Step; agentName: string }) {
  const [triesOpen, setTriesOpen] = useState(false);
  const first = step.tries[0];
  const last = step.tries[step.tries.length - 1];
  const [detailsOpen, setDetailsOpen] = useTaskSheetParam(last.id);
  const earlier = step.tries.slice(0, -1);
  const head = (
    <>
      <TaskStatusIcon status={last.status} className="size-3.5" />
      <span className="shrink-0 font-semibold text-foreground">{agentName}</span>
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
        {outcomeText(step)}
      </span>
      {earlier.length > 0 ? (
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 ease-snappy",
            !triesOpen && "-rotate-90",
          )}
        />
      ) : null}
    </>
  );
  return (
    <div data-slot="worker-step" className="flex min-w-0 flex-col gap-1 py-1">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {earlier.length > 0 ? (
          <button
            type="button"
            aria-expanded={triesOpen}
            onClick={() => setTriesOpen((v) => !v)}
            className="flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {head}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">{head}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 @max-[30rem]/turns:hidden">
          <MessageTime at={first.createdAt} />
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Open task details"
              onClick={() => setDetailsOpen(true)}
              className="shrink-0 text-muted-foreground @max-[30rem]/turns:ml-auto"
            >
              <Maximize2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open details</TooltipContent>
        </Tooltip>
      </div>
      <AnimatedReveal open={triesOpen} speed="fast">
        <ol
          aria-label="Earlier tries"
          className="ml-5 flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-2"
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
      </AnimatedReveal>
      <div className="ml-5 flex min-w-0 flex-col gap-1.5">
        <ChainOfThought taskId={last.id} status={last.status} />
        <TaskOutcome task={last} />
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
