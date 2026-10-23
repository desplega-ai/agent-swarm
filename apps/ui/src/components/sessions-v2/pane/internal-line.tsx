import {
  ChevronDown,
  Clock,
  CornerDownRight,
  type LucideIcon,
  Play,
  Shuffle,
  SkipForward,
} from "lucide-react";
import { useState } from "react";
import type { AgentTask } from "@/api/types";
import { TaskOutcome } from "@/components/sessions/task-outcome";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { Badge } from "@/components/ui/badge";
import { markdownPreview } from "@/lib/markdown-preview";
import { promptTitle } from "@/lib/prompt-display";
import { cn } from "@/lib/utils";
import { MessageTime } from "./swarm-reply";

const KINDS: Record<string, { label: string; icon: LucideIcon }> = {
  "follow-up": { label: "Follow-up", icon: CornerDownRight },
  deferred: { label: "Deferred", icon: Clock },
  resume: { label: "Resume", icon: Play },
  "reroute-decision": { label: "Reroute", icon: Shuffle },
};

/** The output to read in full: an answer, or a failure. */
function fullText(task: AgentTask): string | null {
  if (task.status === "completed") return task.output?.trim() || null;
  if (task.status === "failed" || task.status === "cancelled")
    return task.failureReason?.trim() || null;
  return null;
}

/** One plain line: the output, the failure, else the first line of the task. */
function preview(task: AgentTask): string {
  const full = fullText(task);
  if (full) return markdownPreview(full);
  if (task.status === "pending" || task.status === "unassigned") return "Waiting for the lead.";
  return markdownPreview(promptTitle(task.task));
}

/**
 * An internal handoff (SPEC R7): a follow-up, a deferred wake-up, a resume,
 * a reroute, a superseded task, or a lead note that only sent more work. The
 * Handoffs toggle shows these quiet rows among the steps: a plain preview
 * that opens the full output (`TaskOutcome`). They get no Copy (SPEC R10.2).
 */
export function InternalLine({ task }: { task: AgentTask }) {
  const [open, setOpen] = useState(false);
  const kind =
    task.status === "superseded"
      ? { label: "Superseded", icon: SkipForward }
      : (KINDS[task.taskType ?? ""] ?? { label: "Handoff", icon: CornerDownRight });
  const Icon = kind.icon;
  const expandable = fullText(task) !== null;
  const row = (
    <>
      <Icon aria-hidden className="mt-1 size-3.5 shrink-0" />
      <Badge variant="outline" size="tag" className="mt-0.5 shrink-0 border-dashed">
        {kind.label}
      </Badge>
      {/* Open: the full output below takes the place of the preview. */}
      <span className="line-clamp-2 min-w-0 flex-1 leading-relaxed wrap-anywhere">
        {open ? null : preview(task)}
      </span>
      {expandable ? (
        <ChevronDown
          aria-hidden
          className={cn(
            "mt-1 size-3 shrink-0 transition-transform duration-150 ease-snappy",
            !open && "-rotate-90",
          )}
        />
      ) : null}
      <span className="mt-0.5 shrink-0 pl-2 @max-[30rem]/turns:hidden">
        <MessageTime at={task.createdAt} />
      </span>
    </>
  );
  const rowClass =
    "flex w-full min-w-0 items-start gap-1.5 py-1 text-left text-xs text-muted-foreground";
  return (
    <div data-slot="internal-line" className="min-w-0">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            rowClass,
            "rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
          )}
        >
          {row}
        </button>
      ) : (
        <div className={rowClass}>{row}</div>
      )}
      <AnimatedReveal open={open} speed="fast">
        <div className="ml-5 pb-1.5">
          <TaskOutcome task={task} />
        </div>
      </AnimatedReveal>
    </div>
  );
}
