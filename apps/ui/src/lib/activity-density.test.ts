import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../api/types";
import { buildDensityLanes, densityPeak } from "./activity-density";

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
