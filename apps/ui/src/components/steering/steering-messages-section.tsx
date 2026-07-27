/**
 * Steering — lifecycle readout for a task's steering messages.
 *
 * Rendered as its **own section**, deliberately not folded into
 * `SessionLogViewer` / the `src/logs-parser/` normalized IR: steering messages
 * are user intent with their own state machine, not harness transcript events.
 * Merging them into the shared timeline IR is tracked as a follow-up.
 *
 * Status moves `pending → delivered → handled`, or terminates at `promoted`
 * (became a follow-up task) / `cancelled`. It updates off the existing 5s REST
 * poll in `useTaskSteeringMessages` — there is no websocket/SSE channel.
 */

import { MessageSquareShare } from "lucide-react";
import { Link } from "react-router-dom";
import type { SteeringMessage, SteeringStatus } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSmartTime } from "@/lib/utils";

/** Status-token classes per lifecycle state (no raw palette literals — lint gate). */
const STATUS_CLASS: Record<SteeringStatus, string> = {
  pending: "border-status-pending/30 text-status-pending-strong",
  delivered: "border-status-info/30 text-status-info-strong",
  handled: "border-status-success/30 text-status-success-strong",
  promoted: "border-status-paused/30 text-status-paused-strong",
  cancelled: "border-status-neutral/30 text-muted-foreground",
};

const STATUS_HINT: Record<SteeringStatus, string> = {
  pending: "Waiting for the worker to pick it up.",
  delivered: "Handed to the harness — the agent hasn't acknowledged it yet.",
  handled: "The agent acknowledged handling this message.",
  promoted: "Couldn't be delivered live, so it became a follow-up task.",
  cancelled: "Cancelled before delivery.",
};

function StatusChip({ message }: { message: SteeringMessage }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" size="tag" className={STATUS_CLASS[message.status]}>
          {message.status}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="left">{STATUS_HINT[message.status]}</TooltipContent>
    </Tooltip>
  );
}

export interface SteeringMessagesSectionProps {
  messages: SteeringMessage[];
  className?: string;
}

export function SteeringMessagesSection({ messages, className }: SteeringMessagesSectionProps) {
  if (messages.length === 0) return null;

  return (
    <CollapsibleSection
      variant="card"
      title="Steering"
      icon={MessageSquareShare}
      iconColor="text-status-info"
      borderColor="border-border"
      bgColor="bg-muted/20"
      className={className}
      defaultOpen
      persistKey="agent-swarm-task-steering-open"
      badge={
        <Badge variant="outline" size="tag">
          {messages.length}
        </Badge>
      }
    >
      <ul className="flex flex-col gap-2 max-h-64 overflow-y-auto">
        {messages.map((message) => (
          <li
            key={message.id}
            className="rounded-md border border-border bg-background/60 px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="outline" size="tag">
                {message.mode === "steer" ? "interrupt" : "queue"}
              </Badge>
              {message.deliveredMode && message.deliveredMode !== message.mode ? (
                <Badge variant="outline" size="tag" className="text-muted-foreground">
                  delivered as {message.deliveredMode}
                </Badge>
              ) : null}
              <StatusChip message={message} />
              <span className="text-[10px] text-muted-foreground ml-auto">
                {formatSmartTime(message.handledAt ?? message.deliveredAt ?? message.createdAt)}
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap break-words">
              {message.body}
            </p>
            {message.promotedTaskId ? (
              <Link
                to={`/tasks/${message.promotedTaskId}`}
                className="mt-1 inline-block text-[10px] font-mono text-primary hover:underline"
              >
                → follow-up #{message.promotedTaskId.slice(0, 8)}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}
