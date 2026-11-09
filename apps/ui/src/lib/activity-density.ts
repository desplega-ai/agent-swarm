// The Home activity density view: tasks counted per agent per time bin, so a
// busy swarm (hundreds of tasks an hour) reads as a calm row of bars instead
// of hundreds of truncated blocks.

import type { AgentTask, AgentTaskStatus } from "../api/types";

export type DensityKind = "done" | "failed" | "running";

/** Statuses the view counts, and what each counts as. Queued work is not activity yet. */
const KIND_OF: Partial<Record<AgentTaskStatus, DensityKind>> = {
  completed: "done",
  cancelled: "done",
  failed: "failed",
  in_progress: "running",
  paused: "running",
  reviewing: "running",
};

export interface DensityBin {
  /** Bin start (ms since epoch). */
  start: number;
  done: number;
  failed: number;
  running: number;
  /** The tasks in the bin, newest first, for the bin's list. */
  tasks: AgentTask[];
}

export interface DensityLane {
  /** The agent id, `unassigned`, or `quiet` for the folded lane. */
  id: string;
  name: string;
  total: number;
  failed: number;
  bins: DensityBin[];
  /** The agents folded into the quiet lane, by name. */
  members?: string[];
}

export interface DensityInput {
  tasks: AgentTask[];
  agents: { id: string; name: string }[];
  startMs: number;
  endMs: number;
  binMs: number;
  /** Lanes kept before the rest fold into one "quiet agents" lane. */
  maxLanes: number;
}

/** When a task's work started: accepted, else created. */
export function taskStartMs(task: AgentTask): number {
  return new Date(task.acceptedAt ?? task.createdAt).getTime();
}

function emptyBins(startMs: number, count: number, binMs: number): DensityBin[] {
  return Array.from({ length: count }, (_, index) => ({
    start: startMs + index * binMs,
    done: 0,
    failed: 0,
    running: 0,
    tasks: [],
  }));
}

function addTo(bin: DensityBin, kind: DensityKind, task: AgentTask) {
  bin[kind] += 1;
  bin.tasks.push(task);
}

/**
 * Count each task in the bin where its work started, per agent. Lanes sort by
 * task count; past `maxLanes`, the rest (and agents with no task) fold into
 * one lane so a quiet agent never costs a row.
 */
export function buildDensityLanes({
  tasks,
  agents,
  startMs,
  endMs,
  binMs,
  maxLanes,
}: DensityInput): DensityLane[] {
  const count = Math.max(1, Math.ceil((endMs - startMs) / binMs));
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const lanes = new Map<string, DensityLane>();
  for (const agent of agents) {
    lanes.set(agent.id, {
      id: agent.id,
      name: agent.name,
      total: 0,
      failed: 0,
      bins: emptyBins(startMs, count, binMs),
    });
  }

  const sorted = [...tasks].sort((a, b) => taskStartMs(b) - taskStartMs(a));
  for (const task of sorted) {
    const kind = KIND_OF[task.status];
    if (!kind) continue;
    const at = taskStartMs(task);
    if (at < startMs || at >= endMs) continue;
    const id = task.agentId ?? "unassigned";
    let lane = lanes.get(id);
    if (!lane) {
      lane = {
        id,
        name: id === "unassigned" ? "Unassigned" : (names.get(id) ?? "Unknown agent"),
        total: 0,
        failed: 0,
        bins: emptyBins(startMs, count, binMs),
      };
      lanes.set(id, lane);
    }
    const bin = lane.bins[Math.min(count - 1, Math.floor((at - startMs) / binMs))];
    if (!bin) continue;
    addTo(bin, kind, task);
    lane.total += 1;
    if (kind === "failed") lane.failed += 1;
  }

  const ranked = [...lanes.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
  const kept = ranked.filter((lane, index) => index < maxLanes && lane.total > 0);
  const folded = ranked.filter((lane) => !kept.includes(lane));
  if (folded.length === 0) return kept;

  const quiet: DensityLane = {
    id: "quiet",
    name: `${folded.length} quiet ${folded.length === 1 ? "agent" : "agents"}`,
    total: 0,
    failed: 0,
    bins: emptyBins(startMs, count, binMs),
    members: folded.map((lane) => lane.name),
  };
  for (const lane of folded) {
    quiet.total += lane.total;
    quiet.failed += lane.failed;
    lane.bins.forEach((bin, index) => {
      const target = quiet.bins[index];
      if (!target) return;
      target.done += bin.done;
      target.failed += bin.failed;
      target.running += bin.running;
      target.tasks.push(...bin.tasks);
    });
  }
  return [...kept, quiet];
}

/** The busiest bin across all lanes: the height every bar scales to. */
export function densityPeak(lanes: DensityLane[]): number {
  let peak = 0;
  for (const lane of lanes) {
    for (const bin of lane.bins) peak = Math.max(peak, bin.done + bin.failed + bin.running);
  }
  return peak;
}

export interface DensityTick {
  at: number;
  /** Centre of the label, in px from the axis's left edge. */
  x: number;
}

const HOUR_MS = 60 * 60 * 1000;
/** Hour steps the axis may thin to, in order of preference. */
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

/**
 * Hour ticks for an axis `widthPx` wide. The step grows (1h, 2h, 3h...) until
 * neighbouring labels sit `labelPx + gapPx` apart, ticks land on local hours
 * divisible by the step, and a tick is dropped when its label would leave the
 * axis or run into the `reservePx` kept free at the right edge (the "now" pill).
 */
export function densityHourTicks({
  startMs,
  endMs,
  widthPx,
  labelPx,
  reservePx,
  gapPx = 8,
}: {
  startMs: number;
  endMs: number;
  widthPx: number;
  labelPx: number;
  reservePx: number;
  gapPx?: number;
}): DensityTick[] {
  if (widthPx <= 0 || endMs <= startMs) return [];
  const pxPerHour = (widthPx * HOUR_MS) / (endMs - startMs);
  const step =
    HOUR_STEPS.find((hours) => hours * pxPerHour >= labelPx + gapPx) ??
    HOUR_STEPS[HOUR_STEPS.length - 1]!;
  const ticks: DensityTick[] = [];
  for (let at = Math.ceil(startMs / HOUR_MS) * HOUR_MS; at < endMs; at += HOUR_MS) {
    if (new Date(at).getHours() % step !== 0) continue;
    const x = ((at - startMs) / (endMs - startMs)) * widthPx;
    if (x - labelPx / 2 < 0) continue;
    if (x + labelPx / 2 > widthPx - reservePx - gapPx) continue;
    ticks.push({ at, x });
  }
  return ticks;
}
