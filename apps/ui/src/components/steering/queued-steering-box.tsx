/**
 * Steering — the "not delivered yet" tail bar.
 *
 * `pending` messages have no place in the session log stream: nothing has
 * entered the session yet, so there is no honest timestamp to interleave them
 * at. Instead they pin to the TAIL of the log stream, right above the
 * "Agent is working…" footer, as a single-line collapsed bar sized like the
 * footer it sits on. When the worker picks a message up its status flips to
 * `delivered` and it leaves this bar for its inline position in the stream —
 * no extra bookkeeping needed, the two views partition on `status`.
 */

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { SteeringMessage } from "@/api/types";
import { cn } from "@/lib/utils";
import { SteeringLine } from "./steering-message-chips";

export interface QueuedSteeringBoxProps {
  messages: SteeringMessage[];
  className?: string;
}

export function QueuedSteeringBox({ messages, className }: QueuedSteeringBoxProps) {
  const [open, setOpen] = useState(false);
  if (messages.length === 0) return null;

  return (
    <div className={cn("shrink-0 border-t border-border bg-muted/20", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-[12.5px]"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium text-status-pending-strong">
          {messages.length} queued
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {open ? null : messages[0]?.body.replace(/\s+/g, " ").trim()}
        </span>
      </button>
      {open ? (
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto px-3 pb-2 text-[12px]">
          {messages.map((message) => (
            <SteeringLine key={message.id} message={message} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
