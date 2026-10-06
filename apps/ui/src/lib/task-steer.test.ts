import { describe, expect, test } from "bun:test";
import type { AgentTaskStatus } from "@/api/types";
import { canSteerSessionTask, canSteerTask } from "./task-steer";

const STATUSES: AgentTaskStatus[] = [
  "draft",
  "backlog",
  "unassigned",
  "offered",
  "reviewing",
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "superseded",
];

describe("canSteerTask (task page)", () => {
  test("steers a running, queued or paused task of any assignee", () => {
    const steerable = STATUSES.filter((status) => canSteerTask({ status }));
    expect(steerable).toEqual(["pending", "in_progress", "paused"]);
  });
});

describe("canSteerSessionTask (Sessions)", () => {
  test("steers only a running or queued lead task", () => {
    const steerable = STATUSES.filter((status) =>
      canSteerSessionTask({ status, isLeadTask: true }),
    );
    expect(steerable).toEqual(["pending", "in_progress"]);
  });

  test("never steers a worker task or a missing task", () => {
    for (const status of STATUSES) {
      expect(canSteerSessionTask({ status, isLeadTask: false })).toBe(false);
      expect(canSteerSessionTask({ status })).toBe(false);
    }
    expect(canSteerSessionTask(null)).toBe(false);
    expect(canSteerSessionTask(undefined)).toBe(false);
  });
});
