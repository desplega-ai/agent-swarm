/**
 * Chain-of-thought indicator — inline activity feed for an agent turn,
 * rendered as a Trace.
 *
 * Merges three sources into one chronological list of Trace lines:
 *   - the canonical `AgentLog[]` activity stream via `useTask(id)` (the same
 *     data the task-detail page renders under "Activity"),
 *   - the main agent's tool calls and reasoning, parsed from the session
 *     transcript (`useTaskSessionLogs`). Sub-agent steps stay in the detail
 *     sheet's transcript,
 *   - steering messages (≥1.122.1), rendered as a distinct user-injected line.
 *
 * Visible states:
 *   - active (`pending` / `offered` / `in_progress`): always rendered, last
 *     line shimmers. While the task is active the queries poll (4 s activity,
 *     5 s transcript and steering) so new steps flow into the list live.
 *   - terminal (`completed` / `failed` / `cancelled` / `superseded`): one
 *     collapsible "Activity · N" line, collapsed by default, that expands on
 *     click — the breadcrumb stays without dominating the timeline.
 *
 * Long feeds show only the latest steps, with an "N earlier steps" line that
 * reveals the rest.
 *
 * Polling cost is deliberately bounded: the transcript and steering fetches
 * are enabled only for tasks that are still active, or terminal tasks the
 * user has explicitly expanded — a long session's historical rows never fire
 * a request.
 */

import {
  Bot,
  Brain,
  Check,
  CircleDot,
  FileText,
  Globe,
  type LucideIcon,
  MessageSquareShare,
  Plug,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import { useTask, useTaskSessionLogs, useTaskSteeringMessages } from "@/api/hooks/use-tasks";
import type { AgentLog, AgentTaskStatus, SteeringMessage } from "@/api/types";
import type { ToolKind } from "@/components/shared/session-log-messages";
import { classifyTool } from "@/components/shared/session-log-viewer";
import { SteeringLine } from "@/components/steering/steering-message-chips";
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
import { cn, formatRelativeTime } from "@/lib/utils";
import { type ParsedMessage, parseSessionLogs, type ToolResultBlock } from "@/logs-parser";

const ACTIVE_STATUSES = new Set<AgentTaskStatus>([
  "pending",
  "offered",
  "backlog",
  "unassigned",
  "draft",
  "in_progress",
  "paused",
  "reviewing",
]);

/** Steps shown before the "N earlier steps" line takes over. */
const VISIBLE_STEPS = 8;

const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  mcp: Plug,
  bash: Terminal,
  file: FileText,
  web: Globe,
  task: Bot,
  skill: Sparkles,
  other: Wrench,
};

function summarizeAgentLog(log: AgentLog): string | null {
  switch (log.eventType) {
    case "task_created":
      return "Created";
    case "task_offered":
      return "Offered to agent";
    case "task_accepted":
      return "Accepted";
    case "task_rejected":
      return "Rejected";
    case "task_claimed":
      return "Claimed";
    case "task_released":
      return "Released";
    case "task_status_change": {
      const old = log.oldValue ?? "";
      const next = log.newValue ?? "";
      if (!next) return null;
      if (old) return `${old} → ${next}`;
      return next;
    }
    case "task_progress": {
      const v = log.newValue?.trim();
      if (!v) return "Progress update";
      // Skip JSON envelopes — only show plain prose progress notes.
      if (v.startsWith("{") || v.startsWith("[")) return null;
      return v.length > 140 ? `${v.slice(0, 140)}…` : v;
    }
    case "channel_message":
    case "agent_joined":
    case "agent_left":
    case "agent_status_change":
      // Not interesting at the per-task level.
      return null;
    default:
      return null;
  }
}

type Step =
  | { kind: "log"; id: string; text: string; createdAt: string }
  | { kind: "steer"; id: string; message: SteeringMessage; createdAt: string }
  | {
      kind: "tool";
      id: string;
      toolKind: ToolKind;
      title: string;
      detail: string;
      /** `undefined` while the call has no result yet. */
      ok?: boolean;
      createdAt: string;
    }
  | { kind: "thinking"; id: string; text: string; createdAt: string };

/** The main agent's tool calls and reasoning blocks, in transcript order. */
function transcriptSteps(messages: ParsedMessage[]): Step[] {
  const results = new Map<string, ToolResultBlock>();
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === "tool_result") results.set(block.tool_use_id, block);
    }
  }
  const out: Step[] = [];
  for (const m of messages) {
    if (m.parentToolUseId) continue;
    m.content.forEach((block, idx) => {
      const id = `${m.id}-${idx}`;
      if (block.type === "tool_use") {
        const tool = classifyTool(block.name, block.input);
        const result = results.get(block.id);
        out.push({
          kind: "tool",
          id,
          toolKind: tool.kind,
          title: tool.title,
          detail: tool.detail.trim(),
          ok: result ? !result.isError : undefined,
          createdAt: m.timestamp,
        });
      } else if (block.type === "thinking" && block.thinking.trim()) {
        out.push({ kind: "thinking", id, text: block.thinking.trim(), createdAt: m.timestamp });
      }
    });
  }
  return out;
}

function stepTime(step: Step): number {
  const t = Date.parse(step.createdAt);
  return Number.isFinite(t) ? t : 0;
}

function stepSummary(step: Step): string {
  switch (step.kind) {
    case "log":
      return step.text;
    case "steer":
      return "Steering message";
    case "tool":
      return step.detail ? `${step.title} ${step.detail}` : step.title;
    case "thinking":
      return "Thinking";
  }
}

export interface ChainOfThoughtProps {
  taskId: string;
  status: AgentTaskStatus;
  className?: string;
}

export function ChainOfThought({ taskId, status, className }: ChainOfThoughtProps) {
  const isActive = ACTIVE_STATUSES.has(status);
  // Poll while the task is active so new activity rows flow in. Stop polling
  // once the task reaches a terminal state.
  const { data: task } = useTask(taskId, { refetchInterval: isActive ? 4000 : false });

  const [expanded, setExpanded] = useState(false);

  // Same gate as everywhere else. Both hooks are react-query-cached globals
  // (`/health` version + `/stats`), so calling them per timeline row costs one
  // shared subscription rather than one request each.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: steeringMessages } = useTaskSteeringMessages(taskId, {
    enabled: steerGate.supported && steeringEnabled && (isActive || expanded),
    refetchInterval: isActive ? 5000 : false,
  });
  // Shares the detail sheet's query key, so opening the sheet reuses it. A
  // disabled query still returns the cached transcript, so a turn watched
  // live keeps its steps once it ends.
  const { data: sessionLogs } = useTaskSessionLogs(taskId, {
    enabled: isActive || expanded,
    refetchInterval: isActive ? 5000 : false,
  });
  const messages = useMemo(() => parseSessionLogs(sessionLogs ?? []), [sessionLogs]);

  const steps = useMemo<Step[]>(() => {
    const logs = task?.logs ?? [];
    const out: Step[] = [];
    for (const log of logs) {
      const text = summarizeAgentLog(log);
      if (!text) continue;
      out.push({ kind: "log", id: log.id, text, createdAt: log.createdAt });
    }
    out.push(...transcriptSteps(messages));
    for (const message of steeringMessages ?? []) {
      out.push({
        kind: "steer",
        id: `steer-${message.id}`,
        message,
        createdAt: message.createdAt,
      });
    }
    // Stable chronological merge. Each source already arrives ordered; the
    // sort only has to interleave them.
    out.sort((a, b) => stepTime(a) - stepTime(b));
    return out;
  }, [task?.logs, messages, steeringMessages]);

  // Active task with no events yet — show a shimmering placeholder so the row
  // never reads as silent immediately after the user sends.
  if (steps.length === 0) {
    if (!isActive) return null;
    return (
      <Trace className={className} aria-live="polite">
        <div>
          <TraceLine status="running" className="text-xs">
            <TraceIcon>
              <CircleDot className="size-3 text-primary" />
            </TraceIcon>
            <TraceTitle>
              {status === "in_progress" ? "Thinking…" : "Waiting for an agent to pick this up…"}
            </TraceTitle>
          </TraceLine>
        </div>
      </Trace>
    );
  }

  if (isActive) {
    return (
      <Trace className={className} aria-live="polite" aria-label="Agent reasoning">
        <StepList steps={steps} isActive />
      </Trace>
    );
  }

  // Terminal state — one collapsible line with the count, plus the last step
  // while collapsed. The transcript loads on expand, so the count waits for
  // it rather than jumping from the activity-only number.
  const last = steps[steps.length - 1];
  const count = sessionLogs ? ` ${steps.length}` : "";
  return (
    <Trace className={className}>
      <TraceCollapsible open={expanded} onOpenChange={setExpanded}>
        <TraceCollapsibleTrigger
          className="hit-area"
          aria-label={`${expanded ? "Hide" : "Show"}${count} activity steps`}
        >
          <TraceLine className="text-[11px]">
            <TraceIcon>
              <Sparkles className="size-3 opacity-70" />
            </TraceIcon>
            <TraceTitle>
              <span className="font-mono uppercase tracking-wider text-[9px]">
                Activity{count ? ` ·${count}` : ""}
              </span>
              {!expanded && last ? (
                <span className="italic opacity-80"> · {stepSummary(last)}</span>
              ) : null}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="mt-1.5">
          <Trace className="gap-1.5" aria-label="Agent reasoning">
            <StepList steps={steps} isActive={false} />
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

function StepList({ steps, isActive }: { steps: Step[]; isActive: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  return (
    <>
      {hidden > 0 ? (
        <button type="button" className="hit-area" onClick={() => setShowAll(true)}>
          <TraceLine className="text-[11px]">
            <TraceTitle className="font-mono uppercase tracking-wider text-[9px]">
              {hidden} earlier {hidden === 1 ? "step" : "steps"}
            </TraceTitle>
          </TraceLine>
        </button>
      ) : null}
      {shown.map((step, idx) => (
        <StepItem key={step.id} step={step} running={isActive && idx === shown.length - 1} />
      ))}
    </>
  );
}

function StepTime({ createdAt }: { createdAt: string }) {
  return (
    <TraceDescription
      className="font-mono text-[10px] text-muted-foreground/60"
      title={new Date(createdAt).toLocaleString()}
    >
      {formatRelativeTime(createdAt)}
    </TraceDescription>
  );
}

function StepItem({ step, running }: { step: Step; running: boolean }) {
  if (step.kind === "steer") {
    return (
      <div className="min-w-0">
        <SteeringLine
          message={step.message}
          className="text-xs"
          marker={
            <MessageSquareShare className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
          }
          trailing={
            <span
              className="text-[10px] font-mono text-muted-foreground/60 shrink-0"
              title={new Date(step.createdAt).toLocaleString()}
            >
              {formatRelativeTime(step.createdAt)}
            </span>
          }
        />
      </div>
    );
  }

  if (step.kind === "thinking") {
    return <ThinkingStep text={step.text} running={running} />;
  }

  if (step.kind === "tool") {
    const Icon = TOOL_ICONS[step.toolKind];
    const status = step.ok === false ? "error" : running ? "running" : undefined;
    return (
      <div title={stepSummary(step)}>
        <TraceLine status={status} className="text-xs">
          <TraceIcon>
            <Icon className="size-3" />
          </TraceIcon>
          <TraceTitle className="font-mono">
            {step.title}
            {step.detail ? <span className="opacity-70"> {step.detail}</span> : null}
          </TraceTitle>
          <StepTime createdAt={step.createdAt} />
        </TraceLine>
      </div>
    );
  }

  return (
    <div title={step.text}>
      <TraceLine status={running ? "running" : undefined} className="text-xs">
        <TraceIcon>
          {running ? (
            <CircleDot className="size-3 text-primary animate-pulse" />
          ) : (
            <Check className="size-3 text-muted-foreground/70" />
          )}
        </TraceIcon>
        <TraceTitle className={cn(running && "font-medium")}>{step.text}</TraceTitle>
        <StepTime createdAt={step.createdAt} />
      </TraceLine>
    </div>
  );
}

/** A reasoning block: a one-line preview that opens to the full text. */
function ThinkingStep({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ");
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger className="hit-area">
        <TraceLine status={running ? "running" : undefined} className="text-xs">
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
