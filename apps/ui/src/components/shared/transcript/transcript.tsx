/**
 * The transcript: one task's run as a chat, shared by the task page, the
 * Sessions timeline's activity feed and the Sessions task sheet.
 *
 * The layout follows T3 Code's chat timeline
 * (https://github.com/pingdotgg/t3code, MIT License, Copyright (c) 2026 T3
 * Tools Inc.): the person's message is a right-aligned bubble, the agent's
 * prose is plain markdown with no bubble, a run of tool calls is one summary
 * line that opens to compact 24 px lines, a live run shows its newest step
 * with a "Working for" timer, and a finished run folds behind "Worked for".
 * Rows come from `buildTranscriptRows` (transcript-rows.ts).
 *
 * A steering message is the person's message too, right-aligned, with a
 * "Queued" mark until the agent gets it. A delegated task is one line
 * (agent, status, duration) that links to its own transcript. The task's
 * outcome comes last, as the final reply. A long run shows its newest
 * `TRANSCRIPT_PAGE_ROWS` rows, with "Show older" above them, so a 1,000-row
 * run mounts a page at a time.
 */

import {
  ArrowDown,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleDot,
  Clock,
  FileText,
  Globe,
  type LucideIcon,
  Plug,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentTask } from "@/api/types";
import { MarkdownView } from "@/components/shared/markdown-view";
import type { ToolKind } from "@/components/shared/session-log-messages";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Button } from "@/components/ui/button";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { statusLabel } from "@/lib/status-labels";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatDuration, formatRelativeTime, parseUTCDate } from "@/lib/utils";
import {
  entrySummary,
  foldedTurnRows,
  pagedRows,
  summarizeWork,
  TRANSCRIPT_PAGE_ROWS,
  type TranscriptRow,
  type WorkEntry,
} from "./transcript-rows";

const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  mcp: Plug,
  bash: Terminal,
  file: FileText,
  web: Globe,
  task: Bot,
  skill: Sparkles,
  other: Wrench,
};

/** A person's message collapses past 8 lines or 600 characters. */
const LONG_MESSAGE_LINES = 8;
const LONG_MESSAGE_CHARS = 600;

export interface TranscriptFold {
  /** "Worked for 4m 12s". */
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface TranscriptProps {
  rows: TranscriptRow[];
  /** The run is live: the last work row shows its newest step, and nothing folds. */
  running: boolean;
  /** The person's message above the run (`TranscriptUserMessage`). */
  prompt?: ReactNode;
  /** The task's outcome, after every row: the run's final reply. */
  outcome?: ReactNode;
  /**
   * The outcome's text. A folded run hides the agent's last message when it
   * says the same, so the answer shows once.
   */
  outcomeText?: string;
  /** A finished run folds behind this line. Without it, every row shows. */
  fold?: TranscriptFold | null;
  /** When the live run started: the "Working for" timer counts from it. */
  workingSince?: string;
  /** Shown while a live run has no rows yet ("Thinking…"). */
  waitingLabel?: string;
  /** The page's scroller: a live run follows its bottom, with a "Jump to latest" button. */
  scroller?: HTMLElement | null;
  className?: string;
}

export function Transcript({
  rows,
  running,
  prompt,
  outcome,
  outcomeText,
  fold,
  workingSince,
  waitingLabel,
  scroller,
  className,
}: TranscriptProps) {
  const activeFold = running ? null : (fold ?? null);
  const [limit, setLimit] = useState(TRANSCRIPT_PAGE_ROWS);
  const { shown, hidden } = pagedRows(
    activeFold ? foldedTurnRows(rows, activeFold.open, { outcomeText }) : rows,
    limit,
  );
  const liveRowId = running ? rows[rows.length - 1]?.id : undefined;
  const contentRef = useFollowEnd(scroller ?? null, running);

  return (
    <div
      ref={contentRef}
      data-slot="transcript"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      {prompt}
      {activeFold ? <TurnFoldRow fold={activeFold} /> : null}
      {hidden > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-slot="transcript-show-older"
          className="self-center text-muted-foreground"
          onClick={() => setLimit(limit + TRANSCRIPT_PAGE_ROWS)}
        >
          Show {Math.min(hidden, TRANSCRIPT_PAGE_ROWS)} older ({hidden.toLocaleString()} hidden)
        </Button>
      ) : null}
      {shown.map((row) => (
        <TranscriptRowView key={row.id} row={row} live={row.id === liveRowId} />
      ))}
      {outcome}
      {running && rows.length === 0 && waitingLabel ? (
        <Trace aria-live="polite">
          <div>
            <TraceLine status="running" className="text-xs">
              <TraceIcon>
                <CircleDot className="size-3 text-primary" />
              </TraceIcon>
              <TraceTitle>{waitingLabel}</TraceTitle>
            </TraceLine>
          </div>
        </Trace>
      ) : null}
      {running && workingSince ? <WorkingRow since={workingSince} /> : null}
      {scroller ? <ScrollToEndButton scroller={scroller} /> : null}
    </div>
  );
}

function TranscriptRowView({ row, live }: { row: TranscriptRow; live: boolean }) {
  switch (row.kind) {
    case "assistant":
      return (
        <div data-slot="transcript-assistant" className="min-w-0 px-1 text-sm leading-relaxed">
          <MarkdownView text={row.text} />
        </div>
      );
    case "steer":
      return (
        <TranscriptUserMessage
          text={row.message.body}
          label="Steering message"
          footer={
            row.message.status === "pending" ? (
              <span
                data-slot="transcript-queued"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              >
                <Clock aria-hidden className="size-3" />
                Queued
              </span>
            ) : null
          }
        />
      );
    case "delegation":
      return <DelegationCard task={row.task} agentName={row.agentName} />;
    case "work":
      return <WorkRow entries={row.entries} live={live} />;
  }
}

/** A delegated task, one line: agent, status and duration, linking to its own transcript. */
function DelegationCard({ task, agentName }: { task: AgentTask; agentName: string | null }) {
  const start = parseUTCDate(task.acceptedAt ?? task.createdAt).getTime();
  const end = task.finishedAt ? parseUTCDate(task.finishedAt).getTime() : Number.NaN;
  const ran = Number.isFinite(end - start) ? formatDuration(Math.max(0, end - start)) : null;
  return (
    <Link
      to={`/tasks/${task.id}`}
      data-slot="transcript-delegation"
      className="-mx-2 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <TaskStatusIcon status={task.status} label={statusLabel(task.status)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{taskListTitle(task)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          Delegated to {agentName ?? "an agent"} · {statusLabel(task.status)}
          {ran ? ` · ${ran}` : ""}
        </span>
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

/**
 * The person's message: a right-aligned bubble. A long one shows its first
 * lines under a fade, with "Show full message". The task's prompt and every
 * steering message use it.
 */
export function TranscriptUserMessage({
  text,
  header,
  footer,
  label = "Task prompt",
  className,
}: {
  text: string;
  /** Above the text inside the bubble (a Slack thread's context). */
  header?: ReactNode;
  /** Under the bubble, right-aligned (a steering message's "Queued"). */
  footer?: ReactNode;
  /** The section's accessible name. */
  label?: string;
  className?: string;
}) {
  const long = text.length > LONG_MESSAGE_CHARS || text.split("\n").length > LONG_MESSAGE_LINES;
  const [expanded, setExpanded] = useState(false);
  const clipped = long && !expanded;
  return (
    <section
      aria-label={label}
      data-slot="transcript-user"
      className={cn("flex min-w-0 flex-col items-end gap-1", className)}
    >
      <div
        className={cn(
          "relative max-w-[80%] min-w-0 overflow-hidden rounded-2xl rounded-tr-sm bg-muted px-3.5 py-2 text-base leading-relaxed whitespace-pre-wrap wrap-anywhere md:text-sm",
          clipped && "max-h-44 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
        )}
      >
        {header}
        {text}
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="hit-area text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : "Show full message"}
        </button>
      ) : null}
      {footer}
    </section>
  );
}

/** "Worked for 4m 12s" over a rule. A click shows the hidden rows below it. */
function TurnFoldRow({ fold }: { fold: TranscriptFold }) {
  return (
    <button
      type="button"
      aria-expanded={fold.open}
      onClick={() => fold.onOpenChange(!fold.open)}
      className="group/fold flex min-w-0 items-center gap-1.5 border-b border-border/60 pb-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <span className="truncate">{fold.label}</span>
      <ChevronRight
        aria-hidden
        className={cn("size-3.5 shrink-0 transition-transform", fold.open && "rotate-90")}
      />
    </button>
  );
}

/** "Working for 12s": counts up every second while the run is live. */
function WorkingRow({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const start = parseUTCDate(since).getTime();
  const ms = Number.isFinite(start) ? Math.max(0, now - start) : 0;
  return (
    <p
      data-slot="transcript-working"
      className="shimmer-text text-sm text-muted-foreground"
      data-status="running"
    >
      Working for {formatDuration(ms)}
    </p>
  );
}

/**
 * A run of work. One tool call is its own line. More fold into a summary
 * line that opens to every step; a live run also shows its newest step.
 */
function WorkRow({ entries, live }: { entries: WorkEntry[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const newest = entries[entries.length - 1];
  if (entries.length === 1 && newest.kind !== "thinking") {
    return (
      <Trace>
        <WorkEntryLine entry={newest} running={live} />
      </Trace>
    );
  }
  const failed = entries.some((e) => e.kind === "tool" && e.status === "error");
  return (
    <Trace data-slot="transcript-work" className="gap-1">
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger className="hit-area">
          <TraceLine status={failed ? "error" : undefined} className="text-sm">
            <TraceTitle>{summarizeWork(entries)}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="mt-1 max-h-[min(18rem,50dvh)] overflow-y-auto">
          <Trace className="gap-1">
            {entries.map((entry) => (
              <WorkEntryLine key={entry.id} entry={entry} running={false} />
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {live && !open ? <WorkEntryLine entry={newest} running /> : null}
    </Trace>
  );
}

function EntryTime({ at }: { at: string }) {
  return (
    <TraceDescription
      className="font-mono text-[10px] text-muted-foreground/60"
      title={new Date(at).toLocaleString()}
    >
      {formatRelativeTime(at)}
    </TraceDescription>
  );
}

function WorkEntryLine({ entry, running }: { entry: WorkEntry; running: boolean }) {
  if (entry.kind === "thinking") return <ThinkingLine text={entry.text} running={running} />;
  if (entry.kind === "tool") {
    const Icon = TOOL_ICONS[entry.toolKind];
    const status =
      entry.status === "error"
        ? "error"
        : running || entry.status === "running"
          ? "running"
          : undefined;
    return (
      <div title={entrySummary(entry)}>
        <TraceLine status={status} className="min-h-6 text-xs">
          <TraceIcon>
            <Icon className="size-3" />
          </TraceIcon>
          <TraceTitle className="font-mono">
            {entry.title}
            {entry.detail ? <span className="opacity-70"> {entry.detail}</span> : null}
          </TraceTitle>
          <EntryTime at={entry.at} />
        </TraceLine>
      </div>
    );
  }
  return (
    <div title={entry.text}>
      <TraceLine status={running ? "running" : undefined} className="min-h-6 text-xs">
        <TraceIcon>
          {running ? (
            <CircleDot className="size-3 text-primary animate-pulse" />
          ) : (
            <Check className="size-3 text-muted-foreground/70" />
          )}
        </TraceIcon>
        <TraceTitle className={cn(running && "font-medium")}>{entry.text}</TraceTitle>
        <EntryTime at={entry.at} />
      </TraceLine>
    </div>
  );
}

/** A reasoning block: a one-line preview that opens to the full text. */
function ThinkingLine({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ");
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger className="hit-area">
        <TraceLine status={running ? "running" : undefined} className="min-h-6 text-xs">
          <TraceIcon>
            <Brain className="size-3" />
          </TraceIcon>
          <TraceTitle>
            <span className="font-medium italic">Thinking</span>
            {open ? null : <span className="opacity-70"> {preview}</span>}
          </TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="mt-1 text-xs whitespace-pre-wrap">
        {text}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Within this many pixels of the bottom counts as at the end. */
const AT_END_PX = 40;

function distanceToEnd(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/**
 * Keeps a live run's newest rows in view. A live run opens at its newest
 * row; the scroller then follows the bottom while the reader is there.
 * Scrolling up lets go, and coming back to the bottom follows again.
 */
function useFollowEnd(
  scroller: HTMLElement | null,
  live: boolean,
): (el: HTMLDivElement | null) => void {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!scroller || !content || !live) return;
    scroller.scrollTop = scroller.scrollHeight;
    let following = true;
    const onScroll = () => {
      following = distanceToEnd(scroller) <= AT_END_PX;
    };
    const observer = new ResizeObserver(() => {
      if (following) scroller.scrollTop = scroller.scrollHeight;
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(content);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [scroller, content, live]);
  return setContent;
}

/** "Jump to latest": shows 150 ms after the reader leaves the bottom of a long transcript. */
function ScrollToEndButton({ scroller }: { scroller: HTMLElement }) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const check = () => {
      const far = distanceToEnd(scroller) > AT_END_PX;
      window.clearTimeout(timer);
      if (!far) setAway(false);
      else timer = window.setTimeout(() => setAway(true), 150);
    };
    check();
    scroller.addEventListener("scroll", check, { passive: true });
    return () => {
      window.clearTimeout(timer);
      scroller.removeEventListener("scroll", check);
    };
  }, [scroller]);
  if (!away) return null;
  return (
    <div className="pointer-events-none sticky bottom-[calc(var(--log-sticky-bottom,0px)+0.75rem)] z-10 flex justify-center">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="pointer-events-auto rounded-full bg-background/90 shadow-sm backdrop-blur"
        onClick={() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })}
      >
        <ArrowDown />
        Jump to latest
      </Button>
    </div>
  );
}
