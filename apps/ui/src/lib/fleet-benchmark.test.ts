import { expect, test } from "bun:test";
import type { FleetBenchmarkResponse } from "@/api/types";
import {
  fleetCardMode,
  fleetPlacement,
  formatFleetMedian,
  formatFleetValue,
} from "./fleet-benchmark";

const response = (state: FleetBenchmarkResponse["state"]): FleetBenchmarkResponse => ({
  state,
  local: null,
  minFinishedTasks: 10,
  generatedAt: null,
  comparisons: [],
});

const base = { benchmarkDismissed: false, inviteOpen: false, workflowRunsCompleted: 0 };

test("the card shows the benchmark when ready and progress under 10 tasks", () => {
  expect(fleetCardMode({ ...base, benchmark: response("ready") })).toBe("benchmark");
  expect(fleetCardMode({ ...base, benchmark: response("not_enough_tasks") })).toBe("progress");
});

test("telemetry off, no org name, unavailable or still loading show nothing", () => {
  for (const state of ["telemetry_off", "no_org_name", "unavailable"] as const) {
    expect(fleetCardMode({ ...base, benchmark: response(state) })).toBeNull();
  }
  expect(fleetCardMode({ ...base, benchmark: undefined })).toBeNull();
});

test("the perk shows alone after a completed workflow, until the invite is resolved", () => {
  const off = response("telemetry_off");
  expect(
    fleetCardMode({ ...base, benchmark: off, inviteOpen: true, workflowRunsCompleted: 1 }),
  ).toBe("perk");
  expect(fleetCardMode({ ...base, benchmark: off, inviteOpen: true })).toBeNull();
  expect(fleetCardMode({ ...base, benchmark: off, workflowRunsCompleted: 3 })).toBeNull();
});

test("a dismissed benchmark falls back to the perk only", () => {
  const ready = response("ready");
  expect(fleetCardMode({ ...base, benchmark: ready, benchmarkDismissed: true })).toBeNull();
  expect(
    fleetCardMode({
      ...base,
      benchmark: ready,
      benchmarkDismissed: true,
      inviteOpen: true,
      workflowRunsCompleted: 1,
    }),
  ).toBe("perk");
});

test("copy", () => {
  expect(formatFleetValue({ key: "tasksPerWeek", value: 95.4 })).toBe("95 tasks/week");
  expect(formatFleetValue({ key: "tasksPerWeek", value: 1.7 })).toBe("1.7 tasks/week");
  expect(formatFleetValue({ key: "taskSuccessRate", value: 0.911 })).toBe("91.1% success");
  expect(formatFleetValue({ key: "taskSuccessRate", value: 1 })).toBe("100% success");
  expect(formatFleetMedian({ key: "taskSuccessRate", p50: 0.93 })).toBe("93%");
  expect(fleetPlacement({ band: "top_25", peers: "2-5" })).toBe(
    "top 25% of swarms with 2-5 agents",
  );
  expect(fleetPlacement({ band: "below_median", peers: "all" })).toBe(
    "below the median of active swarms",
  );
});
