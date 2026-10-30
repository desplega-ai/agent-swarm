import { describe, expect, test } from "bun:test";
import type { AgentTaskStatus } from "@/api/types";
import { canSteerSessionTask, canSteerTask, sessionComposerTarget } from "./task-steer";

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

describe("sessionComposerTarget", () => {
  const lead = (id: string, status: AgentTaskStatus, createdAt: string) => ({
    id,
    status,
    isLeadTask: true,
    createdAt,
  });
  const worker = (id: string, status: AgentTaskStatus, createdAt: string) => ({
    id,
    status,
    isLeadTask: false,
    createdAt,
  });

  test("a running lead turn wins over a newer delegated worker task", () => {
    const chain = [
      lead("root", "completed", "2026-10-30 09:00:00"),
      lead("turn-2", "in_progress", "2026-10-30 09:05:00"),
      worker("child", "in_progress", "2026-10-30 09:06:00"),
    ];
    expect(sessionComposerTarget(chain)?.id).toBe("turn-2");
  });

  test("with nothing live, the newest task is the follow-up parent", () => {
    const chain = [
      lead("root", "completed", "2026-10-30 09:00:00"),
      worker("child", "completed", "2026-10-30 09:06:00"),
    ];
    expect(sessionComposerTarget(chain)?.id).toBe("child");
  });

  test("an empty chain has no target", () => {
    expect(sessionComposerTarget([])).toBeNull();
  });
});
