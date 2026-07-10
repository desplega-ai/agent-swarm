import { describe, expect, test } from "bun:test";
import type { AgentTaskStatus } from "../../apps/ui/src/api/types";
import {
  classifyTaskActivity,
  formatTaskActivityAge,
  getTaskDetailPollInterval,
  getTaskLastActivityAt,
  TASK_ACTIVITY_QUIET_AFTER_MS,
  TASK_ACTIVITY_STUCK_AFTER_MS,
  TASK_DETAIL_POLL_INTERVAL_MS,
  taskIsRunning,
} from "../../apps/ui/src/lib/task-activity";

const NOW_MS = Date.parse("2026-07-10T12:00:00.000Z");

function timestampAtAge(ageMs: number): string {
  return new Date(NOW_MS - ageMs).toISOString();
}

describe("task activity classification", () => {
  test("uses exact quiet and stuck boundaries for in-progress work", () => {
    expect(
      classifyTaskActivity("in_progress", timestampAtAge(TASK_ACTIVITY_QUIET_AFTER_MS - 1), NOW_MS),
    ).toMatchObject({ kind: "active", label: "Active", mayBeStuck: false });

    expect(
      classifyTaskActivity("in_progress", timestampAtAge(TASK_ACTIVITY_QUIET_AFTER_MS), NOW_MS),
    ).toMatchObject({ kind: "quiet", label: "Quiet", mayBeStuck: false });

    expect(
      classifyTaskActivity("in_progress", timestampAtAge(TASK_ACTIVITY_STUCK_AFTER_MS - 1), NOW_MS),
    ).toMatchObject({ kind: "quiet", label: "Quiet", mayBeStuck: false });

    expect(
      classifyTaskActivity("in_progress", timestampAtAge(TASK_ACTIVITY_STUCK_AFTER_MS), NOW_MS),
    ).toMatchObject({ kind: "stuck", label: "May be stuck", mayBeStuck: true });
  });

  test.each<AgentTaskStatus>([
    "backlog",
    "unassigned",
    "offered",
    "reviewing",
    "pending",
  ])("classifies %s as waiting even after the stuck threshold", (status) => {
    expect(
      classifyTaskActivity(status, timestampAtAge(TASK_ACTIVITY_STUCK_AFTER_MS), NOW_MS),
    ).toMatchObject({ kind: "waiting", label: "Waiting", mayBeStuck: false });
  });

  test("classifies paused work without a stuck warning", () => {
    expect(
      classifyTaskActivity("paused", timestampAtAge(TASK_ACTIVITY_STUCK_AFTER_MS), NOW_MS),
    ).toMatchObject({ kind: "paused", label: "Paused", mayBeStuck: false });
  });

  test.each<[AgentTaskStatus, string]>([
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["superseded", "Superseded"],
  ])("classifies terminal status %s by its final state", (status, label) => {
    expect(
      classifyTaskActivity(status, timestampAtAge(TASK_ACTIVITY_STUCK_AFTER_MS), NOW_MS),
    ).toMatchObject({ kind: "terminal", label, mayBeStuck: false });
  });

  test("invalid or missing timestamps are unknown and never stuck", () => {
    expect(classifyTaskActivity("in_progress", undefined, NOW_MS)).toMatchObject({
      kind: "unknown",
      ageMs: null,
      mayBeStuck: false,
    });
    expect(classifyTaskActivity("in_progress", "not-a-date", NOW_MS)).toMatchObject({
      kind: "unknown",
      ageMs: null,
      mayBeStuck: false,
    });
  });

  test("prefers the newest detail event and falls back to lastUpdatedAt", () => {
    expect(
      getTaskLastActivityAt({
        lastUpdatedAt: "2026-07-10T10:00:00.000Z",
        logs: [
          { createdAt: "2026-07-10T11:59:00.000Z" },
          { createdAt: "2026-07-10T11:30:00.000Z" },
        ],
      }),
    ).toBe("2026-07-10T11:59:00.000Z");
    expect(getTaskLastActivityAt({ lastUpdatedAt: "2026-07-10T10:00:00.000Z", logs: [] })).toBe(
      "2026-07-10T10:00:00.000Z",
    );
  });

  test("formats concise relative activity ages", () => {
    expect(formatTaskActivityAge(null)).toBe("unknown");
    expect(formatTaskActivityAge(9_000)).toBe("just now");
    expect(formatTaskActivityAge(42_000)).toBe("42 sec ago");
    expect(formatTaskActivityAge(5 * 60_000)).toBe("5 min ago");
    expect(formatTaskActivityAge(2 * 60 * 60_000)).toBe("2 hr ago");
  });
});

describe("task detail polling", () => {
  test.each<AgentTaskStatus | undefined>([
    undefined,
    "backlog",
    "unassigned",
    "offered",
    "reviewing",
    "pending",
    "in_progress",
    "paused",
  ])("polls non-terminal status %s every five seconds", (status) => {
    expect(getTaskDetailPollInterval(status)).toBe(TASK_DETAIL_POLL_INTERVAL_MS);
  });

  test.each<AgentTaskStatus>([
    "completed",
    "failed",
    "cancelled",
    "superseded",
  ])("stops polling terminal status %s", (status) => {
    expect(getTaskDetailPollInterval(status)).toBe(false);
  });

  test("preserves the existing tri-state session liveness behavior", () => {
    expect(taskIsRunning("in_progress")).toBe(true);
    expect(taskIsRunning("completed")).toBe(false);
    expect(taskIsRunning("paused")).toBeUndefined();
    expect(taskIsRunning("superseded")).toBeUndefined();
  });
});
