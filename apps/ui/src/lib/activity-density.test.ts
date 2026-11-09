import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../api/types";
import { buildDensityLanes, densityHourTicks, densityPeak } from "./activity-density";

const START = Date.UTC(2026, 10, 6, 8, 0);
const MIN = 60_000;

let seq = 0;
function task(agentId: string | null, minute: number, status: AgentTask["status"]): AgentTask {
  seq += 1;
  return {
    id: `t${seq}`,
    agentId,
    status,
    createdAt: new Date(START + minute * MIN).toISOString(),
  } as AgentTask;
}

const agents = [
  { id: "lead", name: "Lead" },
  { id: "coder", name: "Coder" },
  { id: "idle", name: "Idle" },
];

describe("buildDensityLanes", () => {
  test("counts tasks per 15-minute bin by kind, busiest lane first", () => {
    const lanes = buildDensityLanes({
      tasks: [
        task("lead", 1, "completed"),
        task("coder", 2, "completed"),
        task("coder", 3, "failed"),
        task("coder", 20, "in_progress"),
        task("coder", 25, "pending"),
      ],
      agents,
      startMs: START,
      endMs: START + 60 * MIN,
      binMs: 15 * MIN,
      maxLanes: 5,
    });
    expect(lanes.map((lane) => [lane.id, lane.total, lane.failed])).toEqual([
      ["coder", 3, 1],
      ["lead", 1, 0],
      ["quiet", 0, 0],
    ]);
    const coder = lanes[0];
    expect(coder?.bins.map((bin) => [bin.done, bin.failed, bin.running])).toEqual([
      [1, 1, 0],
      [0, 0, 1],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(lanes[2]?.members).toEqual(["Idle"]);
    expect(densityPeak(lanes)).toBe(2);
  });

  test("past maxLanes the rest fold into one quiet lane with their counts", () => {
    const lanes = buildDensityLanes({
      tasks: [
        task("lead", 1, "completed"),
        task("coder", 1, "completed"),
        task("coder", 2, "completed"),
      ],
      agents,
      startMs: START,
      endMs: START + 15 * MIN,
      binMs: 15 * MIN,
      maxLanes: 1,
    });
    expect(lanes.map((lane) => [lane.name, lane.total])).toEqual([
      ["Coder", 2],
      ["2 quiet agents", 1],
    ]);
  });

  test("tasks outside the window and unknown agents", () => {
    const lanes = buildDensityLanes({
      tasks: [
        task("ghost", 5, "completed"),
        task(null, 6, "completed"),
        task("lead", 90, "completed"),
      ],
      agents: [],
      startMs: START,
      endMs: START + 60 * MIN,
      binMs: 15 * MIN,
      maxLanes: 5,
    });
    expect(lanes.map((lane) => lane.name).sort()).toEqual(["Unassigned", "Unknown agent"]);
  });
});

describe("densityHourTicks", () => {
  const start = new Date(2026, 10, 6, 20, 15).getTime();
  const end = start + 8 * 60 * MIN;
  const label = 34;
  const reserve = 28;

  function gaps(widthPx: number) {
    const ticks = densityHourTicks({
      startMs: start,
      endMs: end,
      widthPx,
      labelPx: label,
      reservePx: reserve,
    });
    return { ticks, spacing: ticks.slice(1).map((tick, i) => tick.x - ticks[i]!.x) };
  }

  test("a wide axis labels every hour", () => {
    const { ticks } = gaps(900);
    expect(ticks.map((tick) => new Date(tick.at).getHours())).toEqual([21, 22, 23, 0, 1, 2, 3]);
  });

  test("labels never overlap and clear the reserved edge at any width", () => {
    for (let width = 120; width <= 1600; width += 7) {
      const { ticks, spacing } = gaps(width);
      for (const space of spacing) expect(space).toBeGreaterThanOrEqual(label + 8);
      for (const tick of ticks) {
        expect(tick.x - label / 2).toBeGreaterThanOrEqual(0);
        expect(tick.x + label / 2).toBeLessThanOrEqual(width - reserve - 8);
      }
    }
  });

  test("a phone axis thins to even hours", () => {
    const { ticks } = gaps(230);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) expect(new Date(tick.at).getHours() % 2).toBe(0);
  });

  test("no width, no ticks", () => {
    expect(gaps(0).ticks).toEqual([]);
  });
});
