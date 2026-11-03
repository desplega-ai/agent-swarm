/**
 * The transcript: one task's run as a chat, shared by the task page, the
 * Sessions timeline's activity feed and the Sessions task sheet.
 *
 * The layout follows T3 Code's chat timeline
 * (https://github.com/pingdotgg/t3code, MIT License, Copyright (c) 2026 T3
 * Tools Inc.): the person's message is a right-aligned bubble, the agent's
 * prose is plain markdown with no bubble, a run of tool calls is one summary
 * line that opens to compact 24 px lines (each tool line opens to its full
 * command or input and its output), a live run shows its newest step
 * with a "Working for" timer, and a finished run folds behind "Worked for".
 * Rows come from `buildTranscriptRows` (transcript-rows.ts).
 *
 * A steering message shows its sender and a receipt for its lifecycle.
 * A task this one started links to
 * its own transcript: a delegation is one line (agent, status, duration), a
 * person's follow-up is their message with a status line, and a deferral's
 * wake-up, a resume or the result sent to the lead is one quiet line. The
 * task's outcome comes last, as the final reply, and the tasks started after
 * the run ended (`later`) come after it. A long run shows its newest
 * `TRANSCRIPT_PAGE_ROWS` rows, with "Show older" above them, so a 1,000-row
 * run mounts a page at a time.
 *
 * A live run fakes streaming between polls: a row or step that a poll
 * brings in fades in, and the agent's prose and progress lines reveal their
 * new words (`useRevealText`). What was there at mount shows at once.
 */

import {
  AlarmClock,
  ArrowDown,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleDot,
  FileText,
  Globe,
  type LucideIcon,
  Plug,
  RotateCcw,
  Send,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask, SteeringMessage } from "@/api/types";
import { stripContextFooter } from "@/components/session-panel/model";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { MarkdownView } from "@/components/shared/markdown-view";
import { MessageCopyButton, MessageRawToggle } from "@/components/shared/message-copy-button";
import { PromptContext } from "@/components/shared/prompt-context";
import { RelativeTime } from "@/components/shared/relative-time";
import type { ToolKind } from "@/components/shared/session-log-messages";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { UserAvatar } from "@/components/shared/user-avatar";
import { steeringSenderLabel } from "@/components/steering/steering-message-chips";
import { SteeringReceipt } from "@/components/steering/steering-receipt";
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
import { useCurrentUser } from "@/contexts/current-user-context";
import { useRevealText } from "@/hooks/use-reveal-text";
import { parsePromptDisplay } from "@/lib/prompt-display";
import { statusLabel } from "@/lib/status-labels";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatDuration, formatRelativeTime, parseUTCDate } from "@/lib/utils";
import { MessageText } from "./message-text";
import { ToolDetails } from "./tool-details";
import {
  childKind,
  entrySummary,
  foldedTurnRows,
  newestTime,
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

/**
 * While the run is live: the time (ms) after which a row or step counts as
 * brought in by a poll. It is the newest data time of the first render that
 * had rows, or of a work list when it opened. Both come from the data, so
 * the browser's clock does not matter. Null when the run is not live.
 */
const ArrivedAfter = createContext<number | null>(null);

/** Whether the row or step at `at` arrived while the reader watched. Fixed at mount. */
function useArrived(at: string): boolean {
  const since = useContext(ArrivedAfter);
  const [arrived] = useState(() => since !== null && parseUTCDate(at).getTime() > since);
  return arrived;
}

/** A row or step that arrived fades in (DESIGN.md § Motion), never under reduced motion. */
const ARRIVE_CLASS = "animate-in fade-in-0 duration-200 ease-snappy motion-reduce:animate-none";

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
  /** Tasks started after the run ended (`rowsAfterEnd`), after the outcome. */
  later?: TranscriptRow[];
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
  later,
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
  // Fixed at the first render with rows: rows that a page load or a tab
  // switch shows are not new, whatever their age.
  const [firstSeen, setFirstSeen] = useState<number | null>(null);
  const seen = firstSeen ?? (rows.length > 0 ? newestTime(rows) : null);
  if (firstSeen === null && seen !== null) setFirstSeen(seen);

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
      <ArrivedAfter.Provider value={running ? seen : null}>
        {shown.map((row) => (
          <TranscriptRowView key={row.id} row={row} live={row.id === liveRowId} />
        ))}
      </ArrivedAfter.Provider>
      {outcome}
      {later?.map((row) => (
        <TranscriptRowView key={row.id} row={row} live={false} />
      ))}
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
  const arrived = useArrived(row.at);
  const className = arrived ? ARRIVE_CLASS : undefined;
  switch (row.kind) {
    case "assistant":
      return <AssistantMessage text={row.text} arrived={arrived} />;
    case "steer":
      return <SteeringBubble message={row.message} className={className} />;
    case "child":
      return <ChildRow task={row.task} agentName={row.agentName} className={className} />;
    case "work":
      return <WorkRow entries={row.entries} live={live} className={className} />;
  }
}

/** The sender stays beside a steer as its receipt changes through the lifecycle. */
function SteeringBubble({ message, className }: { message: SteeringMessage; className?: string }) {
  const { userId } = useCurrentUser();
  const { data: users } = useUsers();
  const senderId = message.createdByUserId ?? message.createdByAgentId ?? message.createdByKind;
  const name =
    (message.createdByKind === "user"
      ? users?.find((user) => user.id === message.createdByUserId)?.name
      : undefined) ?? steeringSenderLabel(message);
  const mine = message.createdByKind === "user" && !!userId && message.createdByUserId === userId;
  return (
    <TranscriptUserMessage
      text={message.body}
      label="Steering message"
      className={className}
      align={mine ? "end" : "start"}
      avatar={
        message.createdByKind === "agent" && message.createdByAgentId ? (
          <AgentAvatar agentId={message.createdByAgentId} agentName={name} size="sm" />
        ) : (
          <UserAvatar id={senderId} name={name} />
        )
      }
      footer={
        <>
          {!mine ? <span className="max-w-32 truncate text-meta">{name} ·</span> : null}
          {mine ? <SteeringReceipt message={message} /> : null}
          <RelativeTime at={message.createdAt} className="font-mono text-meta uppercase" />
          {!mine ? <SteeringReceipt message={message} /> : null}
        </>
      }
    />
  );
}

/**
 * The agent's prose, as markdown. In a live run its new words reveal
 * between polls; one that a poll brought in reveals from the start. Copy
 * always takes the full text.
 */
function AssistantMessage({ text, arrived }: { text: string; arrived: boolean }) {
  const live = useContext(ArrivedAfter) !== null;
  const shown = useRevealText(text, live, arrived);
  return (
    <div
      data-slot="transcript-assistant"
      className={cn(
        "group/transcript-message flex min-w-0 items-start gap-1 px-1 text-sm leading-relaxed",
        arrived && ARRIVE_CLASS,
      )}
    >
      <div className="min-w-0 flex-1">
        <MarkdownView text={shown} />
      </div>
      <MessageCopyButton text={text} hover group="transcript-message" />
    </div>
  );
}

/** A task this one started, drawn by its kind (`childKind`). */
function ChildRow({
  task,
  agentName,
  className,
}: {
  task: AgentTask;
  agentName: string | null;
  className?: string;
}) {
  switch (childKind(task)) {
    case "person":
      return <PersonFollowUp task={task} agentName={agentName} className={className} />;
    case "deferred":
      return (
        <ChildLine
          task={task}
          agentName={agentName}
          icon={AlarmClock}
          label={`Deferred until ${shortDateTime(task.createdAt)} ·`}
          className={className}
        />
      );
    case "resume":
      return (
        <ChildLine
          task={task}
          agentName={agentName}
          icon={RotateCcw}
          label={`${resumeLabel(task.tags)} ·`}
          className={className}
        />
      );
    case "notify":
      return (
        <ChildLine
          task={task}
          agentName={agentName}
          icon={Send}
          label="Result sent to"
          className={className}
        />
      );
    case "delegation":
      return <DelegationCard task={task} agentName={agentName} className={className} />;
  }
}

/** "Oct 30, 17:15" in the reader's time zone. */
function shortDateTime(at: string): string {
  return parseUTCDate(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Why the server resumed the work (`ResumeReason`), from the resume's `reason:` tag. */
const RESUME_REASONS: Record<string, string> = {
  graceful_shutdown: "a shutdown",
  context_limits: "a full context window",
  manual_supersede: "a manual restart",
  crash_recovery: "a crash",
};

function resumeLabel(tags: readonly string[] | undefined): string {
  const reason = tags?.find((tag) => tag.startsWith("reason:"))?.slice("reason:".length);
  if (!reason) return "Resumed";
  return `Resumed after ${RESUME_REASONS[reason] ?? reason.replaceAll("_", " ")}`;
}

/** "[avatar] Lead · Completed · 1m 23s": who runs a task this one started, and how it went. */
function ChildAgentStatus({ task, agentName }: { task: AgentTask; agentName: string | null }) {
  const start = parseUTCDate(task.acceptedAt ?? task.createdAt).getTime();
  const end = task.finishedAt ? parseUTCDate(task.finishedAt).getTime() : Number.NaN;
  const ran = Number.isFinite(end - start) ? formatDuration(Math.max(0, end - start)) : null;
  return (
    <>
      {task.agentId ? (
        <AgentAvatar
          agentId={task.agentId}
          agentName={agentName}
          size="xs"
          className="size-4 shrink-0 shadow-none"
        />
      ) : null}
      <span className="truncate">
        {agentName ?? "an agent"} · {statusLabel(task.status)}
        {ran ? ` · ${ran}` : ""}
      </span>
    </>
  );
}

/**
 * A delegated task, one line: its title, then the agent (avatar and name),
 * status and duration, linking to its own transcript.
 */
function DelegationCard({
  task,
  agentName,
  className,
}: {
  task: AgentTask;
  agentName: string | null;
  className?: string;
}) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      data-slot="transcript-delegation"
      className={cn(
        "-mx-2 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60",
        className,
      )}
    >
      <TaskStatusIcon status={task.status} label={statusLabel(task.status)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{taskListTitle(task)}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">Delegated to</span>
          <ChildAgentStatus task={task} agentName={agentName} />
        </span>
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

/**
 * A task the server started (a deferral's wake-up, a resume, the result
 * sent to the lead): one quiet line, its kind's icon and label, then the
 * agent and status, linking to its own transcript.
 */
function ChildLine({
  task,
  agentName,
  icon: Icon,
  label,
  className,
}: {
  task: AgentTask;
  agentName: string | null;
  icon: LucideIcon;
  label: string;
  className?: string;
}) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      data-slot="transcript-child-line"
      className={cn(
        "-mx-2 flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        className,
      )}
    >
      <Icon aria-hidden className="mr-1 size-3.5 shrink-0" />
      <span className="shrink-0">{label}</span>
      <ChildAgentStatus task={task} agentName={agentName} />
      <ChevronRight aria-hidden className="ml-auto size-3.5 shrink-0" />
    </Link>
  );
}

/**
 * A person's follow-up (from the dashboard, Slack or a chat): their message,
 * as the prompt shows it, with a line under it that names them and links to
 * the task it started.
 */
function PersonFollowUp({
  task,
  agentName,
  className,
}: {
  task: AgentTask;
  agentName: string | null;
  className?: string;
}) {
  const { data: users } = useUsers();
  const prompt = parsePromptDisplay(stripContextFooter(task.task));
  const person =
    (task.requestedByUserId
      ? users?.find((user) => user.id === task.requestedByUserId)?.name
      : undefined) ?? prompt.speaker;
  return (
    <TranscriptUserMessage
      className={className}
      text={prompt.ask}
      header={<PromptContext display={prompt} className={prompt.ask ? "mb-2" : undefined} />}
      label="Follow-up message"
      footer={
        <Link
          to={`/tasks/${task.id}`}
          data-slot="transcript-follow-up-status"
          className="flex max-w-full min-w-0 items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className="shrink-0">Follow-up{person ? ` from ${person}` : ""} to</span>
          <ChildAgentStatus task={task} agentName={agentName} />
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        </Link>
      }
    />
  );
}

/**
 * The person's message: a right-aligned bubble, as markdown, with "Show raw"
 * and Copy under it (Copy takes the raw text). A long one shows its first
 * lines under a fade, with "Show full message". The task's prompt and every
 * steering message use it.
 */
export function TranscriptUserMessage({
  text,
  header,
  footer,
  label = "Task prompt",
  className,
  avatar,
  align = "end",
}: {
  text: string;
  /** Above the text inside the bubble (a Slack thread's context). */
  header?: ReactNode;
  /** Under the bubble, beside the message actions. */
  footer?: ReactNode;
  /** The section's accessible name. */
  label?: string;
  className?: string;
  avatar?: ReactNode;
  align?: "start" | "end";
}) {
  const long = text.length > LONG_MESSAGE_CHARS || text.split("\n").length > LONG_MESSAGE_LINES;
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);
  const clipped = long && !expanded;
  return (
    <section
      aria-label={label}
      data-slot="transcript-user"
      className={cn(
        "group/transcript-message flex min-w-0 items-start gap-2.5",
        align === "end" && "flex-row-reverse",
        className,
      )}
    >
      {avatar ? <div className="mt-2 shrink-0">{avatar}</div> : null}
      <div
        className={cn(
          "flex min-w-0 flex-col gap-1.5",
          avatar ? "max-w-[85%]" : "max-w-[80%]",
          align === "end" && "items-end",
        )}
      >
        <div
          className={cn(
            "relative min-w-0 overflow-hidden rounded-2xl px-3.5 py-2 text-base leading-relaxed whitespace-pre-wrap wrap-anywhere md:text-sm",
            align === "end"
              ? "rounded-tr-sm bg-muted"
              : "rounded-tl-sm border border-border bg-card",
            clipped && "max-h-44 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
          )}
        >
          {header}
          <MessageText text={text} raw={raw} />
        </div>
        <div
          className={cn(
            "flex max-w-full min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground",
            align === "end" && "justify-end",
          )}
        >
          {align === "start" ? footer : null}
          {long ? (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="hit-area text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? "Show less" : "Show full message"}
            </button>
          ) : null}
          {text.trim() ? (
            <>
              <MessageRawToggle raw={raw} onRawChange={setRaw} hover group="transcript-message" />
              <MessageCopyButton text={text} hover group="transcript-message" />
            </>
          ) : null}
          {align === "end" ? footer : null}
        </div>
      </div>
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
 * The open list scrolls past 18rem until a tool line in it opens: from then
 * on, until the list closes, it shows every step, so details never scroll
 * inside it. In a live run, a step that arrives while the list is open fades
 * in; the steps that opening it shows do not.
 */
function WorkRow({
  entries,
  live,
  className,
}: {
  entries: WorkEntry[];
  live: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [uncapped, setUncapped] = useState(false);
  const [openedAt, setOpenedAt] = useState(0);
  const since = useContext(ArrivedAfter);
  const newest = entries[entries.length - 1];
  if (entries.length === 1 && newest.kind !== "thinking") {
    return (
      <Trace className={className}>
        <WorkEntryLine key={newest.id} entry={newest} running={live} />
      </Trace>
    );
  }
  return (
    <Trace data-slot="transcript-work" className={cn("gap-1", className)}>
      <TraceCollapsible
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setOpenedAt(newestTime(entries));
          else setUncapped(false);
        }}
      >
        <TraceCollapsibleTrigger className="hit-area">
          {/* The summary stays neutral; only a failed line inside is red. */}
          <TraceLine className="text-sm">
            <TraceTitle>{summarizeWork(entries)}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent
          className={cn("mt-1", !uncapped && "max-h-[min(18rem,50dvh)] overflow-y-auto")}
        >
          <ArrivedAfter.Provider value={since === null ? null : Math.max(since, openedAt)}>
            <Trace className="gap-1">
              {entries.map((entry) => (
                <WorkEntryLine
                  key={entry.id}
                  entry={entry}
                  running={false}
                  onOpen={() => setUncapped(true)}
                />
              ))}
            </Trace>
          </ArrivedAfter.Provider>
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {/* Keyed: a new call gets a closed line, never the details of the call before it. */}
      {live && !open ? <WorkEntryLine key={newest.id} entry={newest} running /> : null}
    </Trace>
  );
}

function EntryTime({ at }: { at: string }) {
  return (
    <TraceDescription className="font-mono text-[10px] text-muted-foreground/60">
      <RelativeTime at={at} focusable={false}>
        {formatRelativeTime(at)}
      </RelativeTime>
    </TraceDescription>
  );
}

function WorkEntryLine({
  entry,
  running,
  onOpen,
}: {
  entry: WorkEntry;
  running: boolean;
  /** A tool line's details opened. */
  onOpen?: () => void;
}) {
  const arrived = useArrived(entry.at);
  const className = arrived ? ARRIVE_CLASS : undefined;
  if (entry.kind === "thinking") {
    return <ThinkingLine text={entry.text} running={running} className={className} />;
  }
  if (entry.kind === "tool") {
    return <ToolLine entry={entry} running={running} onOpen={onOpen} className={className} />;
  }
  return <EventLine entry={entry} running={running} arrived={arrived} />;
}

/** A status event or a progress note. The live one reveals its words. */
function EventLine({
  entry,
  running,
  arrived,
}: {
  entry: Extract<WorkEntry, { kind: "event" }>;
  running: boolean;
  arrived: boolean;
}) {
  const text = useRevealText(entry.text, running, arrived);
  return (
    <div title={entry.text} className={arrived ? ARRIVE_CLASS : undefined}>
      <TraceLine status={running ? "running" : undefined} className="min-h-6 text-xs">
        <TraceIcon>
          {running ? (
            <CircleDot className="size-3 text-primary animate-pulse" />
          ) : (
            <Check className="size-3 text-muted-foreground/70" />
          )}
        </TraceIcon>
        <TraceTitle className={cn(running && "font-medium")}>{text}</TraceTitle>
        <EntryTime at={entry.at} />
      </TraceLine>
    </div>
  );
}

/**
 * Scrolls `el`'s scroll containers, innermost first, until `el` is back at
 * `top` on screen.
 */
function keepInPlace(el: HTMLElement, top: number) {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const delta = el.getBoundingClientRect().top - top;
    if (Math.abs(delta) < 1) return;
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") parent.scrollTop += delta;
  }
}

/**
 * A tool call: one quiet line that opens to its full command or input and its
 * output. Opening it can lift the work list's height cap (`WorkRow`), so the
 * line is scrolled back to where it was clicked.
 */
function ToolLine({
  entry,
  running,
  onOpen,
  className,
}: {
  entry: Extract<WorkEntry, { kind: "tool" }>;
  running: boolean;
  onOpen?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const clickedTop = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each toggle
  useLayoutEffect(() => {
    if (triggerRef.current && clickedTop.current !== null) {
      keepInPlace(triggerRef.current, clickedTop.current);
    }
    clickedTop.current = null;
  }, [open]);
  const toggle = (next: boolean) => {
    clickedTop.current = triggerRef.current?.getBoundingClientRect().top ?? null;
    setOpen(next);
    if (next) onOpen?.();
  };
  const Icon = TOOL_ICONS[entry.toolKind];
  const status =
    entry.status === "error"
      ? "error"
      : running || entry.status === "running"
        ? "running"
        : undefined;
  return (
    <TraceCollapsible open={open} onOpenChange={toggle} className={className}>
      <TraceCollapsibleTrigger
        ref={triggerRef}
        quietChevron
        className="hit-area"
        title={entrySummary(entry)}
      >
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
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="mt-1 mb-2">
        <ToolDetails entry={entry} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A reasoning block: a one-line preview that opens to the full text. */
function ThinkingLine({
  text,
  running,
  className,
}: {
  text: string;
  running: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ");
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen} className={className}>
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
