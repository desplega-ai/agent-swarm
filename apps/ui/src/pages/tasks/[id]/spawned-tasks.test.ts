import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../../../api/types";
import { directChildren } from "./spawned-tasks";

const task = (fields: Partial<AgentTask> & Pick<AgentTask, "id" | "createdAt">): AgentTask => ({
  agentId: "lead",
  task: "",
  status: "completed",
  source: "mcp",
  tags: [],
  priority: 50,
  dependsOn: [],
  lastUpdatedAt: fields.createdAt,
  ...fields,
});

describe("directChildren", () => {
  // The lead's later turn sends the researcher a continuation of its earlier
  // task (parentTaskId = that task) and a coder a fresh task.
  const chain = [
    task({ id: "turn1", createdAt: "2026-11-02T10:00:00.000Z", source: "slack" }),
    task({ id: "r1", createdAt: "2026-11-02T10:01:00.000Z", parentTaskId: "turn1" }),
    task({
      id: "turn2",
      createdAt: "2026-11-02T10:10:00.000Z",
      source: "slack",
      parentTaskId: "turn1",
    }),
    task({
      id: "coder",
      createdAt: "2026-11-02T10:12:00.000Z",
      parentTaskId: "turn2",
      dispatchedByTaskId: "turn2",
    }),
    task({
      id: "r2",
      createdAt: "2026-11-02T10:11:00.000Z",
      parentTaskId: "r1",
      dispatchedByTaskId: "turn2",
    }),
  ];
  const ids = (parentId: string, tasks = chain) => directChildren(parentId, tasks).map((t) => t.id);

  test("a turn lists every task it dispatched, oldest first", () => {
    expect(ids("turn2")).toEqual(["r2", "coder"]);
  });

  test("a continuation is not listed under the task it continues", () => {
    expect(ids("r1")).toEqual([]);
    expect(ids("turn1")).toEqual(["r1", "turn2"]);
  });

  test("older rows and dispatchers outside the chain fall back to parentTaskId", () => {
    const old = chain.map(({ dispatchedByTaskId: _drop, ...t }) => t as AgentTask);
    expect(ids("turn2", old)).toEqual(["coder"]);
    expect(ids("r1", old)).toEqual(["r2"]);
    const foreign = chain.map((t) =>
      t.dispatchedByTaskId ? { ...t, dispatchedByTaskId: "other-session" } : t,
    );
    expect(ids("turn2", foreign)).toEqual(["coder"]);
  });
});
