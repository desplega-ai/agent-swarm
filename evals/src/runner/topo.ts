import type { TaskSpec } from "../types.ts";

/**
 * Dependency-graph helpers for scenario.tasks (round 10 — RUNNER-TOPO).
 *
 * dependsOn entries are scenario-local task INDICES (TaskSpec.dependsOn).
 * Since round 10 forward references are legal: validateScenario only requires
 * each entry to be an integer in [0, tasks.length) that isn't a self-reference,
 * plus a whole-graph acyclicity check (findDependencyCycles below). The runner
 * then derives a creation order via topoOrder.
 */

/**
 * Valid graph edges for task i: integer deps in [0, n) excluding i itself.
 * Self-references and out-of-range entries are reported by validateScenario
 * with their own dedicated errors, so the graph algorithms skip them instead
 * of crashing. Duplicates collapse (also rejected separately at load time).
 */
function validEdges(tasks: readonly TaskSpec[]): number[][] {
  const n = tasks.length;
  return tasks.map((t, i) => [
    ...new Set(
      (t.dependsOn ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d < n && d !== i),
    ),
  ]);
}

/**
 * Whole-graph cycle detection (DFS, three-color). Returns one chain per back
 * edge found, each as task indices with the entry node repeated at the end —
 * e.g. [1, 3, 1] for "1 depends on 3 depends on 1". Deterministic: roots are
 * visited in index order, deps in authored order. Empty array = acyclic.
 */
export function findDependencyCycles(tasks: readonly TaskSpec[]): number[][] {
  const edges = validEdges(tasks);
  const cycles: number[][] = [];
  // 0 = unvisited, 1 = on the current DFS stack, 2 = fully explored.
  const color = new Array<0 | 1 | 2>(tasks.length).fill(0);
  const stack: number[] = [];
  const visit = (i: number): void => {
    color[i] = 1;
    stack.push(i);
    for (const d of edges[i] ?? []) {
      if (color[d] === 0) {
        visit(d);
      } else if (color[d] === 1) {
        // Back edge → the slice of the stack from d to i is a cycle.
        cycles.push([...stack.slice(stack.indexOf(d)), d]);
      }
    }
    stack.pop();
    color[i] = 2;
  };
  for (let i = 0; i < tasks.length; i++) {
    if (color[i] === 0) visit(i);
  }
  return cycles;
}

/**
 * Task-creation order: Kahn's algorithm with a deterministic tiebreak — among
 * ready nodes always pick the LOWEST scenario index. Whenever authoring order
 * is already topological (every registered scenario today), the result IS
 * authoring order, so creation order/logs/artifacts stay identical for the
 * existing catalog. Returns scenario-local task indices.
 *
 * Throws on cycles (including self-references) as a defense-in-depth net —
 * registered scenarios can't reach it because validateScenario rejects cyclic
 * graphs at load time with a chain-naming error.
 */
export function topoOrder(tasks: readonly TaskSpec[]): number[] {
  const n = tasks.length;
  const edges = validEdges(tasks);
  // Self-references are intentionally counted here (not in validEdges' output):
  // a self-dependent task is never ready, surfacing as a cycle below.
  const indegree = tasks.map(
    (t, i) => (edges[i]?.length ?? 0) + ((t.dependsOn ?? []).includes(i) ? 1 : 0),
  );
  const dependents: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((deps, i) => {
    for (const d of deps) dependents[d]?.push(i);
  });
  const order: number[] = [];
  const emitted = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    let next = -1;
    for (let i = 0; i < n; i++) {
      if (!emitted[i] && indegree[i] === 0) {
        next = i;
        break;
      }
    }
    if (next === -1) {
      const stuck = tasks
        .map((t, i) => (emitted[i] ? null : `${i} ("${t.title}")`))
        .filter((s): s is string => s !== null);
      throw new Error(`dependency cycle while topo-sorting tasks: ${stuck.join(", ")} never ready`);
    }
    emitted[next] = true;
    order.push(next);
    for (const dep of dependents[next] ?? []) {
      indegree[dep] = (indegree[dep] ?? 1) - 1;
    }
  }
  return order;
}
