import type { AgentTask } from "@/api/types";
import { ChainOfThought } from "@/components/sessions/chain-of-thought";
import { outcomeCopyText, TaskOutcome } from "@/components/sessions/task-outcome";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { StatusBadge } from "@/components/shared/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { cn } from "@/lib/utils";

/**
 * Copy for one message (SPEC R10.1, R10.2): Check and "Copied" for 1.5 s.
 * `hover` fades it in when the pointer is over the closest `group/message`
 * (150 ms) and keeps it at 70 % on small screens, as `OutcomeCopyShell` does.
 * Otherwise it stays visible and muted. The opacity rides a wrapper, so the
 * Button keeps its own transitions.
 */
export function MessageCopyButton({ text, hover = false }: { text: string; hover?: boolean }) {
  return (
    <span
      className={cn(
        "-my-1 inline-flex shrink-0 transition-opacity duration-150 ease-snappy hover:opacity-100 focus-within:opacity-100",
        hover ? "opacity-70 md:opacity-0 md:group-hover/message:opacity-70" : "opacity-60",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <CopyValueButton
            value={text}
            label="Copy message"
            size="icon-xs"
            // A 44 px touch area on touch screens; the row keeps its height.
            className="text-muted-foreground hit-area [--hit-size:44px] hover:text-foreground"
          />
        </TooltipTrigger>
        <TooltipContent>Copy message</TooltipContent>
      </Tooltip>
    </span>
  );
}

/** "29m ago" in the timeline's meta type, with the full time on hover. */
export function MessageTime({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      title={new Date(at).toLocaleString()}
      className="shrink-0 font-mono text-meta tracking-wider whitespace-nowrap uppercase"
    >
      {formatRelative(at)}
    </time>
  );
}

/**
 * The swarm's reply (SPEC R10.2): no name and no mark, the text first
 * (`TaskOutcome`, without its hover Copy), then a footer with the time and an
 * always-visible Copy of the same text. A reply still at work shows its live
 * activity. A failed or cancelled one keeps the tinted frame.
 */
export function SwarmReply({ task }: { task: AgentTask }) {
  if (!TERMINAL_STATUSES.has(task.status)) {
    return <ChainOfThought taskId={task.id} status={task.status} />;
  }
  const copyText = outcomeCopyText(task);
  return (
    <div data-slot="swarm-reply" className="flex min-w-0 flex-col gap-1.5">
      <TaskOutcome task={task} hideCopy />
      <div className="flex min-h-4 items-center gap-1.5 text-muted-foreground">
        <MessageTime at={task.finishedAt ?? task.lastUpdatedAt} />
        {task.status === "failed" || task.status === "cancelled" ? (
          <StatusBadge status={task.status} />
        ) : null}
        {copyText ? <MessageCopyButton text={copyText} /> : null}
      </div>
    </div>
  );
}
