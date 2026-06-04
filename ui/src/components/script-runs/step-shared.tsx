import { Bot, Braces, FileCode2, type LucideIcon, Workflow } from "lucide-react";
import type { ScriptRunJournalEntry } from "@/api/types";

/**
 * Visual + semantic metadata for a journal step type, shared by the source-code
 * view (block highlights) and the timeline panel (rows + bars). Colors come from
 * the action-* semantic tokens (the same palette workflow nodes use).
 */
export interface StepTypeMeta {
  /** Short human label (e.g. "script"). */
  name: string;
  Icon: LucideIcon;
  /** Text accent — `text-action-script`. */
  accent: string;
  /** Solid dot / rail — `bg-action-script`. */
  dot: string;
  /** Timeline duration bar — fill + left edge. */
  bar: string;
  /** Code-block background tint (subtle). */
  codeBg: string;
  /** Left-rail border color (for code blocks / row accents). */
  rail: string;
  /** Top/bottom edge border color — delineates one code block from the next. */
  edge: string;
  /** Outline badge classes. */
  badge: string;
}

const META: Record<string, StepTypeMeta> = {
  "swarm-script": {
    name: "script",
    Icon: FileCode2,
    accent: "text-action-script",
    dot: "bg-action-script",
    bar: "bg-action-script/30 border-l-action-script",
    codeBg: "bg-action-script/10",
    rail: "border-l-action-script",
    edge: "border-action-script/50",
    badge: "border-action-script/40 text-action-script",
  },
  "agent-task": {
    name: "agent task",
    Icon: Bot,
    accent: "text-action-agent-task",
    dot: "bg-action-agent-task",
    bar: "bg-action-agent-task/30 border-l-action-agent-task",
    codeBg: "bg-action-agent-task/10",
    rail: "border-l-action-agent-task",
    edge: "border-action-agent-task/50",
    badge: "border-action-agent-task/40 text-action-agent-task",
  },
  "raw-llm": {
    name: "llm",
    Icon: Braces,
    accent: "text-action-raw-llm",
    dot: "bg-action-raw-llm",
    bar: "bg-action-raw-llm/30 border-l-action-raw-llm",
    codeBg: "bg-action-raw-llm/10",
    rail: "border-l-action-raw-llm",
    edge: "border-action-raw-llm/50",
    badge: "border-action-raw-llm/40 text-action-raw-llm",
  },
};

export function stepTypeMeta(stepType: string): StepTypeMeta {
  return (
    META[stepType] ?? {
      name: stepType,
      Icon: Workflow,
      accent: "text-muted-foreground",
      dot: "bg-status-neutral",
      bar: "bg-action-default/30 border-l-action-default",
      codeBg: "bg-action-default/10",
      rail: "border-l-action-default",
      edge: "border-action-default/50",
      badge: "border-border text-muted-foreground",
    }
  );
}

/**
 * Sub-second-aware duration formatter. `formatElapsed`/`formatDuration` floor to
 * whole seconds (120ms → "0s"); the timeline needs millisecond fidelity.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2).replace(/0$/, "")}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** A journal entry laid out on the timeline: measured duration + cumulative offset. */
export interface TimelineStep {
  entry: ScriptRunJournalEntry;
  index: number;
  offsetMs: number;
  durationMs: number;
}

/**
 * Lay journal steps end-to-end by their measured wall-clock duration, producing a
 * cumulative offset per step (a sequential cascade). Step `startedAt`/`completedAt`
 * are only second-precise, so `durationMs` (sub-second, measured in-subprocess) is
 * the trustworthy timing signal — we reconstruct the waterfall from it.
 */
export function buildSteps(journal: ScriptRunJournalEntry[]) {
  let cursor = 0;
  let max = 0;
  const steps: TimelineStep[] = journal.map((entry, index) => {
    const durationMs = typeof entry.durationMs === "number" ? Math.max(0, entry.durationMs) : 0;
    const offsetMs = cursor;
    cursor += durationMs;
    if (durationMs > max) max = durationMs;
    return { entry, index, offsetMs, durationMs };
  });
  return { steps, totalMs: cursor, maxMs: max, hasTiming: cursor > 0 };
}
