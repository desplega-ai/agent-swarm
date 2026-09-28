import { describe, expect, test } from "bun:test";
import type { AgentTask, AgentTaskStatus } from "../api/types";
import { deriveSessionStatus } from "./session-status";

function task(
  id: string,
  status: AgentTaskStatus,
  lastUpdatedAt = "2026-09-25T10:00:00Z",
): AgentTask {
  return { id, status, lastUpdatedAt, createdAt: lastUpdatedAt } as AgentTask;
}

describe("deriveSessionStatus", () => {
  test("a failed root with live children reads in_progress, not failed", () => {
    const root = task("root", "failed");
    const chain = [root, task("a", "in_progress"), task("b", "pending"), task("c", "completed")];
    expect(deriveSessionStatus(root, chain)).toEqual({ status: "in_progress", failedCount: 1 });
  });

  test("queued work without a live task reads pending", () => {
    const root = task("root", "completed");
    expect(deriveSessionStatus(root, [root, task("a", "pending")]).status).toBe("pending");
  });

  test("all terminal: the most recently updated task wins", () => {
    const root = task("root", "failed", "2026-09-25T10:00:00Z");
    const retry = task("retry", "completed", "2026-09-25T11:00:00Z");
    expect(deriveSessionStatus(root, [root, retry])).toEqual({
      status: "completed",
      failedCount: 1,
    });
  });

  test("a lone failed root stays failed", () => {
    const root = task("root", "failed");
    expect(deriveSessionStatus(root, [])).toEqual({ status: "failed", failedCount: 1 });
  });

  test("the root is counted once when the chain repeats it", () => {
    const root = task("root", "failed");
    expect(deriveSessionStatus(root, [root, root]).failedCount).toBe(1);
  });

  test("an offer nobody accepted is not in progress", () => {
    const root = task("root", "failed");
    expect(deriveSessionStatus(root, [root, task("a", "offered")])).toEqual({
      status: "offered",
      failedCount: 1,
    });
    expect(deriveSessionStatus(root, [root, task("a", "reviewing")]).status).toBe("reviewing");
  });

  test("an accepted task outranks an open offer", () => {
    const root = task("root", "offered");
    expect(deriveSessionStatus(root, [root, task("a", "pending")]).status).toBe("pending");
  });

  test("backlog and draft work does not read as queued to run", () => {
    const root = task("root", "completed");
    expect(deriveSessionStatus(root, [root, task("a", "backlog")]).status).toBe("backlog");
    expect(deriveSessionStatus(root, [root, task("a", "draft")]).status).toBe("draft");
    expect(
      deriveSessionStatus(root, [root, task("a", "draft"), task("b", "unassigned")]).status,
    ).toBe("unassigned");
  });
});
