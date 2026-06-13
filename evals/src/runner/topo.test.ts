import { describe, expect, test } from "bun:test";
import type { TaskSpec } from "../types.ts";
import { findDependencyCycles, topoOrder } from "./topo.ts";

/** Build a task list from per-index dependsOn arrays. */
function tasks(deps: (number[] | undefined)[]): TaskSpec[] {
  return deps.map((dependsOn, i) => ({
    title: `t${i}`,
    description: `task ${i}`,
    ...(dependsOn ? { dependsOn } : {}),
  }));
}

describe("topoOrder (round 10 — unified upfront creation order)", () => {
  test("no deps → authoring order (identity)", () => {
    expect(topoOrder(tasks([undefined, undefined, undefined]))).toEqual([0, 1, 2]);
  });

  test("chain 0 ← 1 ← 2 stays in authoring order", () => {
    expect(topoOrder(tasks([undefined, [0], [1]]))).toEqual([0, 1, 2]);
  });

  test("diamond (1 and 2 both depend on 0; 3 depends on both) stays in authoring order", () => {
    expect(topoOrder(tasks([undefined, [0], [0], [1, 2]]))).toEqual([0, 1, 2, 3]);
  });

  test("independent roots keep authoring order (lowest-index tiebreak)", () => {
    expect(topoOrder(tasks([undefined, undefined, [0], [1]]))).toEqual([0, 1, 2, 3]);
  });

  test("ANY already-topological authoring order is returned verbatim (current-catalog freeze)", () => {
    // Mixed shape: root, dep on root, second root, dep on both branches.
    expect(topoOrder(tasks([undefined, [0], undefined, [1, 2]]))).toEqual([0, 1, 2, 3]);
  });

  test("forward reference reorders: dep is created before its dependent", () => {
    // task 0 depends on task 2 → 2 must be created first.
    expect(topoOrder(tasks([[2], undefined, undefined]))).toEqual([1, 2, 0]);
  });

  test("forward-ref diamond: ready nodes still emit lowest-index-first", () => {
    // 0 depends on 3; 1 and 3 are roots; 2 depends on 1.
    expect(topoOrder(tasks([[3], undefined, [1], undefined]))).toEqual([1, 2, 3, 0]);
  });

  test("two-node cycle throws and names the stuck tasks", () => {
    expect(() => topoOrder(tasks([[1], [0]]))).toThrow(
      'dependency cycle while topo-sorting tasks: 0 ("t0"), 1 ("t1") never ready',
    );
  });

  test("self-dependency throws as a cycle", () => {
    expect(() => topoOrder(tasks([undefined, [1]]))).toThrow(/dependency cycle/);
  });

  test("empty task list → empty order", () => {
    expect(topoOrder([])).toEqual([]);
  });
});

describe("findDependencyCycles (round 10 — load-time whole-graph check)", () => {
  test("acyclic graphs (chain, diamond, forward refs) report no cycles", () => {
    expect(findDependencyCycles(tasks([undefined, [0], [1]]))).toEqual([]);
    expect(findDependencyCycles(tasks([undefined, [0], [0], [1, 2]]))).toEqual([]);
    expect(findDependencyCycles(tasks([[2], undefined, undefined]))).toEqual([]);
  });

  test("two-node cycle returns the chain with the entry node repeated", () => {
    // 1 depends on 3, 3 depends on 1 (indices chosen to mirror the spec example).
    expect(findDependencyCycles(tasks([undefined, [3], undefined, [1]]))).toEqual([[1, 3, 1]]);
  });

  test("three-node cycle reachable only through a forward ref is still found", () => {
    // 0 → 1 → 2 → 1 (cycle excludes the root).
    expect(findDependencyCycles(tasks([[1], [2], [1]]))).toEqual([[1, 2, 1]]);
  });

  test("self-references and out-of-range entries are NOT reported here (dedicated errors)", () => {
    expect(findDependencyCycles(tasks([[0]]))).toEqual([]);
    expect(findDependencyCycles(tasks([[5], [-1]]))).toEqual([]);
  });

  test("two disjoint cycles are both reported", () => {
    expect(findDependencyCycles(tasks([[1], [0], [3], [2]]))).toEqual([
      [0, 1, 0],
      [2, 3, 2],
    ]);
  });
});
