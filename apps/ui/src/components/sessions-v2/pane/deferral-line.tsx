import { ChevronDown, Clock } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { AgentTask } from "@/api/types";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { deferralText, type TurnPart } from "@/lib/session-turns";
import { cn, formatDuration, parseUTCDate } from "@/lib/utils";
import { SwarmReply } from "./swarm-reply";

/** "worked 2m 56s": the reply's own run, as its "Worked for" fold counts it. */
function workedFor(task: AgentTask): string | null {
  if (!task.finishedAt) return null;
  const ms =
    parseUTCDate(task.finishedAt).getTime() -
    parseUTCDate(task.acceptedAt ?? task.createdAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? `worked ${formatDuration(ms)}` : null;
}

/** A muted clock line that opens `children` below it. */
function WaitRow({
  label,
  onToggle,
  children,
}: {
  label: string;
  /** Called after a person opens or closes the line. */
  onToggle?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div data-slot="deferral-line" className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setOpen((value) => !value);
          onToggle?.();
        }}
        // Phones and touch screens: a 44 px row (UX review R9).
        className="hover-linger -mx-1.5 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11"
      >
        <Clock aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 ease-snappy",
            !open && "-rotate-90",
          )}
        />
      </button>
      <div id={bodyId}>
        <AnimatedReveal open={open} speed="fast">
          {children}
        </AnimatedReveal>
      </div>
    </div>
  );
}

/**
 * A reply that only says the swarm waits (the lead deferred): one muted line,
 * "Waiting on Picateclas · by 17:50 · worked 2m 56s" or "Checking back at
 * 19:20 · worked 1m 29s". A click opens the reply as usual: its work and its
 * full text.
 */
export function DeferralLine({ task, onToggle }: { task: AgentTask; onToggle?: () => void }) {
  const { who, by } = deferralText(task.output);
  // A time alone reads "at 16:12"; a day reads as is ("tomorrow 09:00", "11-02 09:00").
  const back = by ? `Checking back ${/^\d{1,2}:\d{2}$/.test(by) ? "at " : ""}${by}` : "Waiting";
  const label = [who ? `Waiting on ${who}` : back, who && by ? `by ${by}` : null, workedFor(task)]
    .filter(Boolean)
    .join(" · ");
  return (
    <WaitRow label={label} onToggle={onToggle}>
      <div className="pt-1.5 pb-1">
        <SwarmReply task={task} />
      </div>
    </WaitRow>
  );
}

/**
 * Two or more waiting parts in a row as one line: "Waited 3 times (Lead,
 * Picateclas) · latest by 17:50". It opens one `DeferralLine` per wait.
 */
export function DeferralGroup({ parts, onToggle }: { parts: TurnPart[]; onToggle?: () => void }) {
  const texts = parts.map((part) => deferralText(part.reply.output));
  const names = [...new Set(texts.flatMap((text) => (text.who ? [text.who] : [])))];
  const latest = texts.at(-1)?.by;
  const label = `Waited ${parts.length} times${names.length ? ` (${names.join(", ")})` : ""}${
    latest ? ` · latest by ${latest}` : ""
  }`;
  return (
    <WaitRow label={label} onToggle={onToggle}>
      <div className="flex min-w-0 flex-col gap-1 pt-1 pl-5">
        {parts.map((part) => (
          <DeferralLine key={part.id} task={part.reply} onToggle={onToggle} />
        ))}
      </div>
    </WaitRow>
  );
}
