import { Check, CheckCheck, Clock, CornerDownRight, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { SteeringMessage, SteeringStatus } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, parseUTCDate } from "@/lib/utils";
import { steeringSenderLabel } from "./steering-message-chips";

const RECEIPTS = {
  pending: { icon: Clock, label: "Queued", hint: "Waiting for delivery to the agent." },
  delivered: {
    icon: Check,
    label: "Delivered",
    hint: "Delivered to the harness. The agent has not confirmed processing this message.",
  },
  handled: {
    icon: CheckCheck,
    label: "Processed",
    hint: "The agent confirmed handling this message.",
  },
  promoted: {
    icon: CornerDownRight,
    label: "Follow-up task",
    hint: "This message became a follow-up task because live delivery was unavailable.",
  },
  cancelled: { icon: X, label: "Cancelled", hint: "This message was cancelled before delivery." },
} satisfies Record<SteeringStatus, { icon: typeof Check; label: string; hint: string }>;

function ReceiptTime({ label, at }: { label: string; at: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <time dateTime={at}>
          {parseUTCDate(at).toLocaleString([], {
            timeZone: "Europe/Madrid",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}{" "}
          BCN
        </time>
      </dd>
    </div>
  );
}

/** A receipt confirms delivery or the agent's acknowledgement, never inferred processing. */
export function SteeringReceipt({ message }: { message: SteeringMessage }) {
  const { icon: Icon, label, hint } = RECEIPTS[message.status];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`${label}: message status`}
          title={label}
          data-slot="steering-receipt"
          data-status={message.status}
          className={cn(
            "hit-area [--hit-size:44px] text-muted-foreground",
            message.status === "handled" && "text-status-success-strong",
          )}
        >
          <Icon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Message status"
        className="max-h-[min(28rem,calc(100dvh-2rem))] w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto text-xs"
      >
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <Icon aria-hidden className="size-3.5" />
            {label}
          </p>
          <p className="text-muted-foreground">{hint}</p>
        </div>
        <p className="wrap-anywhere text-muted-foreground">
          From {steeringSenderLabel(message)} · {message.mode === "steer" ? "Interrupt" : "Queue"}
          {message.deliveredMode && message.deliveredMode !== message.mode
            ? ` · Delivered as ${message.deliveredMode}`
            : ""}
        </p>
        <dl className="space-y-1 font-mono text-meta">
          <ReceiptTime label="Queued" at={message.createdAt} />
          {message.deliveredAt ? <ReceiptTime label="Delivered" at={message.deliveredAt} /> : null}
          {message.status === "handled" && message.handledAt ? (
            <ReceiptTime label="Processed" at={message.handledAt} />
          ) : null}
        </dl>
        {message.status === "handled" && message.handledNote?.trim() ? (
          <p className="border-l-2 border-border pl-2 whitespace-pre-wrap wrap-anywhere">
            {message.handledNote.trim()}
          </p>
        ) : null}
        {message.promotedTaskId ? (
          <Link to={`/tasks/${message.promotedTaskId}`} className="text-primary underline">
            Open follow-up task
          </Link>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
