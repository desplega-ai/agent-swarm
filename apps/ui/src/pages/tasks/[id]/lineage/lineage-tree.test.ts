import { describe, expect, test } from "bun:test";
import type { AgentTask } from "@/api/types";
import {
  buildLineageTree,
  initialExpanded,
  summarizeLineage,
  visibleChildren,
  WIDE_LIMIT,
} from "./lineage-tree";

let clock = 0;
function task(id: string, parentTaskId?: string, extra: Partial<AgentTask> = {}): AgentTask {
  clock += 1;
  return {
    id,
    key: "",
    agentId: "agent-1",
    task: id,
    status: "completed",
    source: "mcp",
    tags: [],
    priority: 50,
    dependsOn: [],
    parentTaskId,
    createdAt: new Date(Date.UTC(2026, 9, 19, 0, 0, clock)).toISOString(),
    lastUpdatedAt: new Date(Date.UTC(2026, 9, 19, 0, 0, clock)).toISOString(),
    ...extra,
  } as AgentTask;
}

describe("buildLineageTree", () => {
  test("links rows under the root, oldest child first, with the path to the focused task", () => {
    const rows = [
      task("root"),
      task("b", "root"),
      task("a", "root"),
      task("a1", "a"),
      task("a1x", "a1"),
    ];
    // "a" is younger than "b" here, so "b" comes first.
    const tree = buildLineageTree(rows, "root", "a1x")!;
    expect(tree.root.children.map((n) => n.task.id)).toEqual(["b", "a"]);
    expect(tree.path).toEqual(["root", "a", "a1", "a1x"]);
    expect(tree.root.descendants).toBe(4);
    expect(tree.byId.get("a1x")!.depth).toBe(3);
  });

  test("a missing root gives null; a cycle is walked once", () => {
    expect(buildLineageTree([task("x")], "root", "x")).toBeNull();
    const tree = buildLineageTree([task("r"), task("c", "r"), task("r", "c")], "r", "c")!;
    expect(tree.byId.size).toBe(2);
    expect(tree.path).toEqual(["r", "c"]);
  });

  test("a large tree opens only the root and the focused path", () => {
    const rows = [task("root")];
    for (let i = 0; i < 60; i++) rows.push(task(`c${i}`, "root"));
    rows.push(task("deep", "c59"), task("deeper", "deep"), task("leaf", "deeper"));
    const tree = buildLineageTree(rows, "root", "deeper")!;
    expect(initialExpanded(tree)).toEqual(new Set(["root", "c59", "deep", "deeper"]));
  });
});

describe("visibleChildren", () => {
  test("caps a wide fan-out but keeps the child on the focused path", () => {
    const rows = [task("root")];
    for (let i = 0; i < 30; i++) rows.push(task(`c${i}`, "root"));
    const tree = buildLineageTree(rows, "root", "c29")!;
    const { shown, hidden } = visibleChildren(tree.root, undefined, new Set(tree.path));
    expect(shown).toHaveLength(WIDE_LIMIT + 1);
    expect(shown.at(-1)!.task.id).toBe("c29");
    expect(hidden).toBe(30 - WIDE_LIMIT - 1);
    expect(visibleChildren(tree.root, 100, new Set()).hidden).toBe(0);
  });
});

test("summarizeLineage counts tasks, agents, live tasks and cost", () => {
  const summary = summarizeLineage([
    task("a", undefined, { totalCostUsd: 0.5 }),
    task("b", "a", { agentId: "agent-2", status: "in_progress", totalCostUsd: 0.25 }),
    task("c", "a", { agentId: null, status: "pending" }),
  ]);
  expect(summary).toEqual({ tasks: 3, agents: 2, live: 2, costUsd: 0.75 });
});
