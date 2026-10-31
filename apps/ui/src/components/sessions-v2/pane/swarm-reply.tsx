import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import type { AgentTask } from "@/api/types";
import { ChainOfThought } from "@/components/sessions/chain-of-thought";
import { outcomeCopyText, TaskOutcome } from "@/components/sessions/task-outcome";
import { MessageCopyButton, messageActionClass } from "@/components/shared/message-copy-button";
import { RelativeTime } from "@/components/shared/relative-time";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { TERMINAL_STATUSES } from "@/lib/task-activity";

/** Opens the task that wrote a reply, in the same tab. Muted like `MessageCopyButton`. */
function MessageTaskLink({ taskId }: { taskId: string }) {
  return (
    <span className={messageActionClass(false)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground hit-area [--hit-size:44px] hover:text-foreground"
          >
            <Link to={`/tasks/${taskId}`} aria-label="Open task">
              <ExternalLink />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open task</TooltipContent>
      </Tooltip>
    </span>
  );
}

/** "29m ago" in the timeline's meta type, with the full time on hover. */
export function MessageTime({ at, focusable = true }: { at: string; focusable?: boolean }) {
  return (
    <RelativeTime
      at={at}
      focusable={focusable}
      className="shrink-0 font-mono text-meta tracking-wider whitespace-nowrap uppercase"
    >
      {formatRelative(at)}
    </RelativeTime>
  );
}

/**
 * The swarm's reply (SPEC R10.2): no name and no mark. A reply still at work
 * shows its live activity. A finished one keeps that work folded behind
 * "Worked for", as a worker step does, then the text (`TaskOutcome`, without
 * its hover Copy), then a footer with the time, an always-visible Copy of the
 * same text, and a link to the task. A failed or cancelled one keeps the
 * tinted frame.
 */
export function SwarmReply({ task }: { task: AgentTask }) {
  if (!TERMINAL_STATUSES.has(task.status)) {
    return <ChainOfThought taskId={task.id} status={task.status} />;
  }
  const copyText = outcomeCopyText(task);
  return (
    <div data-slot="swarm-reply" className="flex min-w-0 flex-col gap-1.5">
      <ChainOfThought taskId={task.id} status={task.status} task={task} />
      <TaskOutcome task={task} hideCopy />
      <div className="flex min-h-4 items-center gap-1.5 text-muted-foreground">
        <MessageTime at={task.finishedAt ?? task.lastUpdatedAt} />
        {task.status === "failed" || task.status === "cancelled" ? (
          <StatusBadge status={task.status} />
        ) : null}
        {copyText ? <MessageCopyButton text={copyText} /> : null}
        <MessageTaskLink taskId={task.id} />
      </div>
    </div>
  );
}
