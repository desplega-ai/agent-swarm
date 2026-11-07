import { ChevronDown } from "lucide-react";
import { Fragment } from "react";
import { AgentAvatarStack } from "@/components/sessions/session-meta";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { formatSpan } from "@/lib/format-duration-ms";
import type { WorkerSummary as Summary, WorkerStep } from "@/lib/session-turns";
import { plural } from "@/lib/sessions-v2";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { cn } from "@/lib/utils";

const ICON = {
  working: "active",
  waiting: "paused",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/** The steps by the state of their last try, then the retries: "4 done · 1 running". */
function stateCounts(steps: WorkerStep[], summary: Summary) {
  let done = 0;
  let running = 0;
  let queued = 0;
  for (const step of steps) {
    const status = step.tries[step.tries.length - 1].status;
    if (status === "completed") done++;
    else if (status === "in_progress") running++;
    else if (!TERMINAL_STATUSES.has(status)) queued++;
  }
  const { failed, cancelled, retries } = summary;
  return [
    { key: "done", n: done, text: `${done} done` },
    { key: "running", n: running, text: `${running} running`, className: "shimmer-text" },
    { key: "queued", n: queued, text: `${queued} queued` },
    { key: "failed", n: failed, text: `${failed} failed`, className: "text-status-error-strong" },
    { key: "cancelled", n: cancelled, text: `${cancelled} cancelled` },
    { key: "retries", n: retries, text: retries === 1 ? "1 retry" : `${retries} retries` },
  ].filter((count) => count.n > 0);
}

/**
 * The head of a part's worker steps when there are two or more (SPEC R8.3):
 * the worker avatars, "2 workers · 5 steps" (or the one worker's name), the
 * steps by state ("4 done · 1 running", a red "1 failed"), and the time. While
 * work runs, the time counts from the start of the open work. It opens the
 * step rows below.
 */
export function WorkerSummaryLine({
  summary,
  steps,
  nameOf,
  open,
  onToggle,
  controls,
}: {
  summary: Summary;
  /** The part's steps (`partSteps`). */
  steps: WorkerStep[];
  nameOf: (agentId: string | null) => string;
  open: boolean;
  onToggle: () => void;
  /** The id of the steps block this line opens. */
  controls: string;
}) {
  const ids = summary.agentIds;
  const subject = ids.length === 1 ? nameOf(ids[0] ?? null) : plural(ids.length, "worker");
  const title =
    steps.length === ids.length ? subject : `${subject} · ${plural(steps.length, "step")}`;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      // Phones and touch screens: a 44 px row (UX review R9). The right padding
      // lines the time and the chevron up with the step rows in the card.
      className="hover-linger -mx-1.5 flex min-w-0 items-center gap-2.5 rounded-md py-1 pr-4 pl-1.5 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11"
    >
      <AgentAvatarStack
        agentIds={ids}
        max={3}
        nameOf={(id) => (id ? nameOf(id) : undefined)}
        role="img"
        aria-label={ids.map((id) => nameOf(id)).join(", ")}
        className="font-mono text-meta text-muted-foreground"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-data font-semibold text-foreground">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <TaskStatusIcon variant={ICON[summary.state]} className="size-3" />
          <span className="min-w-0 truncate">
            {stateCounts(steps, summary).map((count, index) => (
              <Fragment key={count.key}>
                {index > 0 ? " · " : null}
                <span className={count.className}>{count.text}</span>
              </Fragment>
            ))}
          </span>
        </span>
      </span>
      <span className="shrink-0 font-mono text-meta text-muted-foreground tabular-nums">
        {formatSpan(summary.durationMs)}
      </span>
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snappy",
          !open && "-rotate-90",
        )}
      />
    </button>
  );
}
