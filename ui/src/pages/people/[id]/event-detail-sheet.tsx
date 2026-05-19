/**
 * Side-panel detail view for an `IdentityEvent`. Sliding sheet (right edge)
 * shown when an events-table row is clicked. Replaces the previous inline
 * row-expansion pattern. Mirrors `components/sessions/task-detail-sheet.tsx`
 * for layout and shadcn `<Sheet>` consumption.
 *
 * Renders: event-type icon + humanized label, actor (short + full tooltip),
 * timestamp (relative + absolute), and the before/after JSON payloads as
 * pretty-printed code blocks.
 *
 * Esc / overlay click / Close button (top-right) all dismiss via Radix.
 */

import type { IdentityEvent } from "@/api/types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatRelative } from "@/lib/relative-time";
import { formatSmartTime } from "@/lib/utils";
import { EventIcon } from "../user-status";

function formatActor(actor: string): { short: string; full: string } {
  if (actor.startsWith("op:")) return { short: "Operator", full: actor };
  if (actor.startsWith("system:")) {
    const tail = actor.slice("system:".length);
    return { short: tail || "System", full: actor };
  }
  if (actor.startsWith("user:")) return { short: "User", full: actor };
  return { short: actor.length > 32 ? `${actor.slice(0, 30)}…` : actor, full: actor };
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <pre className="font-mono text-[11px] leading-relaxed bg-muted/40 px-3 py-2 rounded border border-border/40 text-muted-foreground/60">
        —
      </pre>
    );
  }
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className="font-mono text-[11px] leading-relaxed bg-muted/40 px-3 py-2 rounded border border-border/40 overflow-auto max-h-[60vh] whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

export function EventDetailSheet({
  event,
  open,
  onOpenChange,
}: {
  event: IdentityEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col gap-0 p-0 overflow-hidden"
      >
        {!event ? null : (
          <>
            <SheetHeader className="border-b border-border pl-4 pr-12 py-3 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <EventIcon eventType={event.eventType} />
                <SheetTitle className="text-sm font-medium capitalize truncate min-w-0">
                  {event.eventType.replaceAll("_", " ")}
                </SheetTitle>
              </div>
              <SheetDescription className="font-mono text-[10px] text-muted-foreground truncate">
                {event.id}
              </SheetDescription>
            </SheetHeader>

            <div className="border-b border-border px-4 py-2 flex items-center gap-3 text-xs text-muted-foreground shrink-0 flex-wrap">
              <span className="flex items-center gap-1.5">
                <span className="uppercase tracking-wider text-[9px]">When</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>{formatRelative(event.createdAt)}</span>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono text-[10px]">
                    {formatSmartTime(event.createdAt)}
                  </TooltipContent>
                </Tooltip>
              </span>
              <span aria-hidden="true">·</span>
              <span className="flex items-center gap-1.5">
                <span className="uppercase tracking-wider text-[9px]">Actor</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-mono text-[11px] text-foreground/80">
                      {formatActor(event.actor).short}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono text-[10px]">
                    {formatActor(event.actor).full}
                  </TooltipContent>
                </Tooltip>
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <section className="space-y-1.5">
                <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Before
                </h4>
                <JsonBlock value={event.before} />
              </section>
              <section className="space-y-1.5">
                <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  After
                </h4>
                <JsonBlock value={event.after} />
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
