import type { Edge, Node } from "@xyflow/react";
import dagre from "dagre";
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRunStep,
  WorkflowRunStepStatus,
} from "@/api/types";

const TRIGGER_TYPES: WorkflowNodeType[] = [
  "trigger-new-task",
  "trigger-task-completed",
  "trigger-webhook",
  "trigger-email",
  "trigger-slack-message",
  "trigger-github-event",
];
const CONDITION_TYPES: WorkflowNodeType[] = ["llm-classify", "property-match", "code-match"];
export type NodeCategory = "triggerNode" | "conditionNode" | "actionNode";

export function getNodeCategory(type: WorkflowNodeType): NodeCategory {
  if (TRIGGER_TYPES.includes(type)) return "triggerNode";
  if (CONDITION_TYPES.includes(type)) return "conditionNode";
  return "actionNode";
}

export function getNodeLabel(node: WorkflowNode): string {
  if (node.label) return node.label;
  return node.type
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface FlowNodeData {
  label: string;
  nodeType: WorkflowNodeType;
  config: Record<string, unknown>;
  stepStatus?: WorkflowRunStepStatus;
  outputPorts: string[];
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
  for (const edge of definition.edges) {
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

  const edges: Edge[] = definition.edges.map((edge: WorkflowEdge) => {
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
    };
  });

  return { nodes, edges };
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 80;

export function applyDagreLayout(
  nodes: Node<FlowNodeData>[],
  edges: Edge[],
  direction: "TB" | "LR" = "TB",
): Node<FlowNodeData>[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
}
