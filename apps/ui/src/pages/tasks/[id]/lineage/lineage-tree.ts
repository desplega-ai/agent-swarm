import type { AgentTask } from "@/api/types";
import { TERMINAL_STATUSES } from "../../../../lib/task-activity";

export interface LineageNode {
  task: AgentTask;
  children: LineageNode[];
  depth: number;
  /** Every task below this one, at any depth. */
  descendants: number;
}

export interface LineageTree {
  root: LineageNode;
  byId: Map<string, LineageNode>;
  /** Root → focused task, both ends included. Empty when the task is not in the tree. */
  path: string[];
}

/** The root's children sit side by side up to this many; past it they stack like every other level. */
export const ROW_LIMIT = 5;
/** Children per parent shown before a "+N more" button. */
export const WIDE_LIMIT = 8;
/** Trees up to this size open fully; larger ones open only the focused path and the top level. */
const SMALL_TREE = 40;

/**
 * Links the flat lineage rows into a tree under `rootId`, children oldest
 * first. A row whose parent is missing (a server cap cut it) is dropped; a
 * parentTaskId cycle is walked once.
 */
export function buildLineageTree(
  tasks: readonly AgentTask[],
  rootId: string,
  focusId: string,
): LineageTree | null {
  const rootTask = tasks.find((task) => task.id === rootId);
  if (!rootTask) return null;
  const childrenOf = new Map<string, AgentTask[]>();
  for (const task of tasks) {
    if (!task.parentTaskId || task.id === rootId) continue;
    const siblings = childrenOf.get(task.parentTaskId);
    if (siblings) siblings.push(task);
    else childrenOf.set(task.parentTaskId, [task]);
  }
  const byId = new Map<string, LineageNode>();
  const build = (task: AgentTask, depth: number): LineageNode => {
    const node: LineageNode = { task, children: [], depth, descendants: 0 };
    byId.set(task.id, node);
    const children = [...(childrenOf.get(task.id) ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const child of children) {
      if (byId.has(child.id)) continue;
      const built = build(child, depth + 1);
      node.children.push(built);
      node.descendants += 1 + built.descendants;
    }
    return node;
  };
  const root = build(rootTask, 0);

  const path: string[] = [];
  for (let id: string | undefined = focusId; id && byId.has(id); ) {
    path.unshift(id);
    if (id === rootId) break;
    id = byId.get(id)!.task.parentTaskId;
  }
  return { root, byId, path: path[0] === rootId ? path : [] };
}

/**
 * Which nodes start open. A small tree opens fully. A large one opens the
 * root, the path to the focused task and the focused task itself, so the
 * first paint stays a few dozen cards even for a 500-task fan-out.
 */
export function initialExpanded(tree: LineageTree): Set<string> {
  if (tree.byId.size <= SMALL_TREE) {
    return new Set(
      [...tree.byId.values()].filter((n) => n.children.length > 0).map((n) => n.task.id),
    );
  }
  return new Set([tree.root.task.id, ...tree.path]);
}

/** Every node that has children: "Expand all". */
export function allExpandable(tree: LineageTree): Set<string> {
  return new Set(
    [...tree.byId.values()].filter((n) => n.children.length > 0).map((n) => n.task.id),
  );
}

/**
 * The children to draw: the first `WIDE_LIMIT` plus `extra` the reader asked
 * for, plus the child on the focused path when it falls past that.
 */
export function visibleChildren(
  node: LineageNode,
  extra: number | undefined,
  pathIds: ReadonlySet<string>,
): { shown: LineageNode[]; hidden: number } {
  const limit = WIDE_LIMIT + (extra ?? 0);
  if (node.children.length <= limit) return { shown: node.children, hidden: 0 };
  const shown = node.children.slice(0, limit);
  const onPath = node.children.slice(limit).find((child) => pathIds.has(child.task.id));
  if (onPath) shown.push(onPath);
  return { shown, hidden: node.children.length - shown.length };
}

export interface LineageSummary {
  tasks: number;
  agents: number;
  live: number;
  costUsd: number;
}

export function summarizeLineage(tasks: readonly AgentTask[]): LineageSummary {
  const agents = new Set(tasks.map((task) => task.agentId).filter(Boolean));
  return {
    tasks: tasks.length,
    agents: agents.size,
    live: tasks.filter((task) => !TERMINAL_STATUSES.has(task.status)).length,
    costUsd: tasks.reduce((sum, task) => sum + (task.totalCostUsd ?? 0), 0),
  };
}
