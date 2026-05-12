import { type Edge, MarkerType, type Node } from "@xyflow/react";
import dagre from "dagre";
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRunStep,
  WorkflowRunStepStatus,
} from "@/api/types";

const CONDITION_TYPES = new Set(["property-match", "code-match", "validate", "raw-llm"]);
export type NodeCategory = "triggerNode" | "conditionNode" | "actionNode";

export function getNodeCategory(type: WorkflowNodeType): NodeCategory {
  if (type.startsWith("trigger-")) return "triggerNode";
  if (CONDITION_TYPES.has(type)) return "conditionNode";
  return "actionNode";
}

export function getNodeLabel(node: WorkflowNode): string {
  if (node.label) return node.label;
  return node.id;
}

export interface FlowNodeData {
  label: string;
  nodeType: WorkflowNodeType;
  config: Record<string, unknown>;
  stepStatus?: WorkflowRunStepStatus;
  outputPorts: string[];
  selected?: boolean;
  [key: string]: unknown;
}

export function toReactFlowGraph(
  definition: WorkflowDefinition,
  steps?: WorkflowRunStep[],
): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const stepMap = new Map<string, WorkflowRunStep>();
  if (steps) {
    for (const step of steps) {
      stepMap.set(step.nodeId, step);
    }
  }

  // Compute output ports per node from edges
  const outputPortsMap = new Map<string, Set<string>>();
  for (const edge of definition.edges ?? []) {
    if (!outputPortsMap.has(edge.source)) {
      outputPortsMap.set(edge.source, new Set());
    }
    outputPortsMap.get(edge.source)!.add(edge.sourcePort);
  }

  const nodes: Node<FlowNodeData>[] = definition.nodes.map((node) => {
    const step = stepMap.get(node.id);
    const ports = outputPortsMap.get(node.id);
    const outputPorts = ports ? Array.from(ports) : [];
    return {
      id: node.id,
      type: getNodeCategory(node.type),
      position: { x: 0, y: 0 },
      data: {
        label: getNodeLabel(node),
        nodeType: node.type,
        config: node.config,
        stepStatus: step?.status,
        outputPorts,
      },
    };
  });

  const edges: Edge[] = (definition.edges ?? []).map((edge: WorkflowEdge) => {
    const sourceStep = stepMap.get(edge.source);
    const targetStep = stepMap.get(edge.target);
    const bothCompleted = sourceStep?.status === "completed" && targetStep?.status === "completed";
    return {
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourcePort,
      target: edge.target,
      targetHandle: "input",
      label: edge.sourcePort !== "default" ? edge.sourcePort : undefined,
      animated: bothCompleted,
      style: bothCompleted ? { stroke: "var(--color-emerald-500)" } : undefined,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 18,
        height: 18,
        color: bothCompleted ? "var(--color-emerald-500)" : "currentColor",
      },
    };
  });

  return { nodes, edges };
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 80;

/**
 * Detect back-edges (edges that close a cycle) via DFS so that we can lay out
 * the underlying DAG cleanly. Back-edges are still rendered by ReactFlow but
 * are excluded from rank assignment, which dramatically reduces crossings on
 * workflows that contain loops.
 */
function detectBackEdges(nodes: Node<FlowNodeData>[], edges: Edge[]): Set<string> {
  const adjacency = new Map<string, Array<{ target: string; edgeId: string }>>();
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    adjacency.get(edge.source)?.push({ target: edge.target, edgeId: edge.id });
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const roots: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) roots.push(id);
  }
  if (roots.length === 0 && nodes.length > 0) {
    roots.push(nodes[0].id);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const backEdges = new Set<string>();

  const dfs = (nodeId: string) => {
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const { target, edgeId } of adjacency.get(nodeId) ?? []) {
      if (inStack.has(target)) {
        backEdges.add(edgeId);
      } else if (!visited.has(target)) {
        dfs(target);
      }
    }
    inStack.delete(nodeId);
  };

  for (const root of roots) {
    if (!visited.has(root)) dfs(root);
  }
  for (const node of nodes) {
    if (!visited.has(node.id)) dfs(node.id);
  }

  return backEdges;
}

/**
 * Custom "vertical staircase" layout: assigns each node a (depth, column) using
 * a topological walk over forward edges (back-edges excluded so cycles don't
 * confuse the assignment). Children of a branching node are spread across
 * adjacent columns so siblings staircase out instead of stacking on top of
 * one another.
 */
function applyStairLayout(
  nodes: Node<FlowNodeData>[],
  edges: Edge[],
  backEdges: Set<string>,
): Node<FlowNodeData>[] {
  const forwardEdges = edges.filter((e) => !backEdges.has(e.id));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const node of nodes) {
    children.set(node.id, []);
    parents.set(node.id, []);
  }
  for (const edge of forwardEdges) {
    children.get(edge.source)?.push(edge.target);
    parents.get(edge.target)?.push(edge.source);
  }

  // Depth = longest path from any root, computed via Kahn topological order.
  const inDegree = new Map<string, number>();
  for (const node of nodes) inDegree.set(node.id, parents.get(node.id)?.length ?? 0);
  const queue: string[] = [];
  const depth = new Map<string, number>();
  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
      depth.set(node.id, 0);
    }
  }
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    const d = depth.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      depth.set(child, Math.max(depth.get(child) ?? 0, d + 1));
      inDegree.set(child, (inDegree.get(child) ?? 0) - 1);
      if ((inDegree.get(child) ?? 0) === 0) queue.push(child);
    }
  }
  // Any leftovers (shouldn't happen after back-edge removal) get depth 0.
  for (const node of nodes) {
    if (!depth.has(node.id)) depth.set(node.id, 0);
  }

  // Assign columns: walk in topo order, place each node next to its primary
  // parent. Multiple children of one parent fan out: first child stays in
  // the parent's column, siblings step right by an increasing offset.
  const column = new Map<string, number>();
  const occupied = new Map<number, Set<number>>(); // depth -> taken columns

  const reserve = (d: number, c: number): number => {
    let col = c;
    if (!occupied.has(d)) occupied.set(d, new Set());
    const taken = occupied.get(d)!;
    while (taken.has(col)) col++;
    taken.add(col);
    return col;
  };

  for (const id of topoOrder) {
    const par = parents.get(id) ?? [];
    let preferred = 0;
    if (par.length > 0) {
      // Use min parent column as the base, then offset by sibling index.
      const parentCols = par.map((p) => column.get(p) ?? 0);
      const baseCol = Math.min(...parentCols);
      // Among the first parent's children, what's our index?
      const firstParent = par[0];
      const sibs = children.get(firstParent) ?? [];
      const sibIdx = sibs.indexOf(id);
      preferred = baseCol + Math.max(0, sibIdx);
    }
    const finalCol = reserve(depth.get(id) ?? 0, preferred);
    column.set(id, finalCol);
  }

  const COLUMN_WIDTH = NODE_WIDTH + 60;
  const ROW_HEIGHT = NODE_HEIGHT + 60;

  return nodes.map((node) => {
    const c = column.get(node.id) ?? 0;
    const d = depth.get(node.id) ?? 0;
    return {
      ...node,
      position: {
        x: c * COLUMN_WIDTH,
        y: d * ROW_HEIGHT,
      },
    };
  });
}

export function applyDagreLayout(
  nodes: Node<FlowNodeData>[],
  edges: Edge[],
  _direction: "TB" | "LR" = "TB",
): Node<FlowNodeData>[] {
  const backEdges = detectBackEdges(nodes, edges);

  // Try the staircase layout first — it handles cycles cleanly and avoids
  // the long crossing edges dagre produces on workflows with back-edges.
  const stair = applyStairLayout(nodes, edges, backEdges);
  if (stair.length > 0) return stair;

  // Fallback: dagre with cycles broken greedily.
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 100, acyclicer: "greedy" });
  for (const node of nodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) {
    if (!backEdges.has(edge.id)) g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);
  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });
}
