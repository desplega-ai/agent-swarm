import { describe, expect, test } from "bun:test";
import type { AgentTask, TaskLineageResponse } from "@/api/types";
import { collapseAncestors, MAX_ANCESTOR_CRUMBS, taskPathFrom } from "./task-trail";

function row(id: string, parentTaskId?: string): AgentTask {
  return { id, parentTaskId, task: `Task ${id}`, status: "completed" } as AgentTask;
}

function lineage(tasks: AgentTask[]): TaskLineageResponse {
  return { rootTaskId: tasks[0]?.id ?? "", tasks, truncated: false };
}

const ids = (tasks: AgentTask[]) => tasks.map((task) => task.id);

describe("taskPathFrom", () => {
  test("a root task has no ancestors and is its own session root", () => {
    const path = taskPathFrom(lineage([row("r")]), "r");
    expect(path && ids(path.ancestors)).toEqual([]);
    expect(path?.sessionRoot?.id).toBe("r");
  });

  test("lists the ancestors root first, ignoring siblings and children", () => {
    const tasks = [row("r"), row("a", "r"), row("sib", "r"), row("b", "a"), row("t", "b")];
    const path = taskPathFrom(lineage([...tasks, row("child", "t")]), "t");
    expect(path && ids(path.ancestors)).toEqual(["r", "a", "b"]);
    expect(path?.task.id).toBe("t");
    expect(path?.sessionRoot?.id).toBe("r");
  });

  test("a path cut by a server cap has no session root", () => {
    const path = taskPathFrom(lineage([row("a", "gone"), row("t", "a")]), "t");
    expect(path && ids(path.ancestors)).toEqual(["a"]);
    expect(path?.sessionRoot).toBeNull();
  });

  test("a parentTaskId cycle stops instead of looping", () => {
    const path = taskPathFrom(lineage([row("a", "t"), row("t", "a")]), "t");
    expect(path && ids(path.ancestors)).toEqual(["a"]);
    expect(path?.sessionRoot).toBeNull();
  });

  test("null when the task is not in the rows", () => {
    expect(taskPathFrom(lineage([row("r")]), "t")).toBeNull();
  });
});

describe("collapseAncestors", () => {
  const path = ["r", "a", "b", "c", "p"];

  test("a path that fits shows whole", () => {
    expect(collapseAncestors(["r", "p"], MAX_ANCESTOR_CRUMBS)).toEqual({
      head: ["r", "p"],
      hidden: [],
      tail: [],
    });
    expect(collapseAncestors(["r", "a", "p"], 3)).toEqual({
      head: ["r", "a", "p"],
      hidden: [],
      tail: [],
    });
    expect(collapseAncestors([], 0)).toEqual({ head: [], hidden: [], tail: [] });
  });

  test("past the cap, the root and the parent stay and the middle folds", () => {
    expect(collapseAncestors(path, 3)).toEqual({
      head: ["r"],
      hidden: ["a", "b", "c"],
      tail: ["p"],
    });
    expect(collapseAncestors(["r", "a", "b", "p"], 3)).toEqual({
      head: ["r"],
      hidden: ["a", "b"],
      tail: ["p"],
    });
  });

  test("less room keeps the parent, then nothing", () => {
    expect(collapseAncestors(path, 1)).toEqual({
      head: [],
      hidden: ["r", "a", "b", "c"],
      tail: ["p"],
    });
    expect(collapseAncestors(path, 0)).toEqual({ head: [], hidden: path, tail: [] });
    expect(collapseAncestors(["p"], 0)).toEqual({ head: [], hidden: ["p"], tail: [] });
  });

  test("never drops or repeats an ancestor", () => {
    for (let n = 0; n <= 6; n += 1) {
      const ancestors = Array.from({ length: n }, (_, i) => `t${i}`);
      for (let max = 0; max <= 4; max += 1) {
        const { head, hidden, tail } = collapseAncestors(ancestors, max);
        expect([...head, ...hidden, ...tail]).toEqual(ancestors);
        expect(head.length + tail.length).toBeLessThanOrEqual(Math.max(max, 0));
      }
    }
  });
});
