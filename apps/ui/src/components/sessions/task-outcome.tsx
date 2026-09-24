/**
 * Sessions surface — a task's final outcome: inline prose for a completed
 * turn, a tinted frame for failed / cancelled ones. Lives in its own module
 * so `task-card.tsx`, `review-ack.tsx` and `session-timeline.tsx` can share
 * it without importing each other.
 */

import { Check, Copy } from "lucide-react";
import { Streamdown } from "streamdown";
import { renderTaskCitations } from "../../../../../src/utils/task-citations";
import "streamdown/styles.css";
import type { AgentTask } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn, normalizeNewlines } from "@/lib/utils";

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
    return (
      <OutcomeProse text={renderTaskCitations(task.output, task.citations ?? [], "markdown")} />
    );
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
