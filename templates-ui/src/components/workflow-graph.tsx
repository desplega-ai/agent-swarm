"use client";

import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import dagre from "dagre";
import {
  Bell,
  Bot,
  Code2,
  GitBranch,
  type LucideIcon,
  Send,
  UserCheck,
  Workflow,
  Zap,
} from "lucide-react";
import { createElement, useMemo, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import "@xyflow/react/dist/style.css";

interface WorkflowNodeDef {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  next?: string[];
  inputs?: Record<string, unknown>;
}

export interface WorkflowDefinitionLike {
  name?: string;
  description?: string;
  nodes?: WorkflowNodeDef[];
  triggerSchema?: unknown;
}

type NodeCategory = "trigger" | "condition" | "action";

const CONDITION_TYPES = new Set(["property-match", "code-match", "validate", "raw-llm"]);

function getNodeCategory(type: string): NodeCategory {
  if (type.startsWith("trigger-")) return "trigger";
  if (CONDITION_TYPES.has(type)) return "condition";
  return "action";
}

const ICON_BY_TYPE: Record<string, LucideIcon> = {
  "agent-task": Bot,
  script: Code2,
  "swarm-script": Code2,
  notify: Bell,
  "send-message": Send,
  "human-in-the-loop": UserCheck,
};

function getNodeIcon(type: string, category: NodeCategory): LucideIcon {
  if (ICON_BY_TYPE[type]) return ICON_BY_TYPE[type];
  if (category === "trigger") return Zap;
  if (category === "condition") return GitBranch;
  return Workflow;
}

/**
 * One-to-two line summary of a node's config. For agent-task nodes we surface
 * the role plus a truncated task; for everything else we render a couple of the
 * most meaningful scalar config keys.
 */
function summarizeConfig(type: string, config?: Record<string, unknown>): string | null {
  if (!config) return null;
  if (type === "agent-task") {
    const role = typeof config.role === "string" ? config.role : null;
    const task = typeof config.task === "string" ? config.task : null;
    const parts: string[] = [];
    if (role) parts.push(role);
    if (task) parts.push(task.length > 80 ? `${task.slice(0, 80)}…` : task);
    return parts.length ? parts.join(" — ") : null;
  }
  const scalars = Object.entries(config)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${String(v)}`);
  const joined = scalars.join(", ");
  if (!joined) return null;
  return joined.length > 120 ? `${joined.slice(0, 120)}…` : joined;
}

interface FlowNodeData {
  nodeId: string;
  nodeType: string;
  category: NodeCategory;
  summary: string | null;
  [key: string]: unknown;
}

const CATEGORY_ACCENT: Record<NodeCategory, string> = {
  trigger: "border-l-primary",
  condition: "border-l-amber-500",
  action: "border-l-sky-500",
};

const CATEGORY_ICON_BG: Record<NodeCategory, string> = {
  trigger: "bg-primary/10 text-primary",
  condition: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  action: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

function NodeIcon({ type, category }: { type: string; category: NodeCategory }) {
  // `createElement` (rather than `<Icon/>`) keeps the dynamic icon lookup out
  // of JSX so the react-hooks static-components lint rule stays happy.
  return createElement(getNodeIcon(type, category), { className: "h-4 w-4" });
}

function WorkflowFlowNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  return (
    <div
      className={cn(
        "w-[260px] rounded-lg border border-l-4 border-border bg-card px-3 py-2.5 shadow-sm",
        CATEGORY_ACCENT[d.category],
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-muted-foreground" />
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            CATEGORY_ICON_BG[d.category],
          )}
        >
          <NodeIcon type={d.nodeType} category={d.category} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{d.nodeId}</span>
          </div>
          <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {d.nodeType}
          </span>
          {d.summary && (
            <p className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
              {d.summary}
            </p>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = { workflowNode: WorkflowFlowNode };

const NODE_WIDTH = 260;
const NODE_HEIGHT = 90;

function buildGraph(definition: WorkflowDefinitionLike): {
  nodes: Node<FlowNodeData>[];
  edges: Edge[];
} {
  const defNodes = definition.nodes ?? [];

  const rfNodes: Node<FlowNodeData>[] = defNodes.map((node) => {
    const category = getNodeCategory(node.type);
    return {
      id: node.id,
      type: "workflowNode",
      position: { x: 0, y: 0 },
      data: {
        nodeId: node.id,
        nodeType: node.type,
        category,
        summary: summarizeConfig(node.type, node.config),
      },
    };
  });

  // Edges are implied by each node's `next` array (no top-level `edges`).
  const validIds = new Set(defNodes.map((n) => n.id));
  const edges: Edge[] = [];
  for (const node of defNodes) {
    for (const target of node.next ?? []) {
      if (!validIds.has(target)) continue;
      edges.push({
        id: `${node.id}->${target}`,
        source: node.id,
        target,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      });
    }
  }

  // Plain dagre top-to-bottom layout (acyclicer handles any loops gracefully).
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 100, acyclicer: "greedy" });
  for (const node of rfNodes) g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);

  const layoutNodes = rfNodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });

  return { nodes: layoutNodes, edges };
}

const emptySubscribe = () => () => {};

export function WorkflowGraph({ definition }: { definition: WorkflowDefinitionLike }) {
  // This page is statically generated; ReactFlow needs the DOM to measure
  // nodes, so we render a skeleton on the server / first paint and only mount
  // the graph client-side. useSyncExternalStore gives us a stable
  // server-vs-client snapshot without a setState-in-effect.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const { nodes, edges } = useMemo(() => buildGraph(definition), [definition]);

  if (!mounted) {
    return (
      <div className="flex h-[500px] items-center justify-center rounded-lg border border-border bg-card">
        <span className="text-sm text-muted-foreground">Loading workflow graph…</span>
      </div>
    );
  }

  return (
    <div className="h-[500px] rounded-lg border border-border bg-card">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
