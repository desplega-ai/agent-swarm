import { Background, type Edge, type Node, ReactFlow, type Viewport } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import type { WorkflowDefinition, WorkflowRunStep } from "@/api/types";
import { ActionNode } from "@/components/workflows/action-node";
import { ConditionNode } from "@/components/workflows/condition-node";
import {
  applyDagreLayout,
  type FlowNodeData,
  toReactFlowGraph,
} from "@/components/workflows/graph-utils";
import { TriggerNode } from "@/components/workflows/trigger-node";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

const nodeTypes = {
  triggerNode: TriggerNode,
  conditionNode: ConditionNode,
  actionNode: ActionNode,
};

// Mirrors NODE_WIDTH in components/workflows/graph-utils.ts.
const NODE_W = 280;
const PAD = 12;
/** Readable window: 12px node labels stay 9.6px at 0.8 and 12px at 1. */
const MIN_READABLE_ZOOM = 0.8;
const MAX_READABLE_ZOOM = 1;

/**
 * The viewport a phone opens the graph at: the first node in the top corner at
 * a readable zoom, the rest one swipe away. `WorkflowGraph` fits the whole
 * definition instead, which on a 360px canvas leaves node labels at about 5px.
 */
function readableViewport(
  nodes: { position: { x: number; y: number } }[],
  width: number,
): Viewport {
  if (nodes.length === 0) return { x: 0, y: 0, zoom: 1 };
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const maxX = Math.max(...nodes.map((n) => n.position.x + NODE_W));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  const graphWidth = maxX - minX;
  const fitWidth = (width - PAD * 2) / graphWidth;
  const zoom = Math.min(MAX_READABLE_ZOOM, Math.max(MIN_READABLE_ZOOM, fitWidth));
  // A single column is centred; a wider graph starts at its first column.
  const x =
    graphWidth * zoom <= width - PAD * 2
      ? (width - graphWidth * zoom) / 2 - minX * zoom
      : PAD - minX * zoom;
  return { x, y: PAD - minY * zoom, zoom };
}

/**
 * Phone canvas for a workflow definition: a read-only React Flow that opens at
 * a readable zoom (see `readableViewport`), pans by drag, zooms by pinch, and
 * reports node taps. Mount it inside a `ReactFlowProvider` to drive it with
 * `useReactFlow()` (fit view) from outside.
 * (Proposal for the shared `WorkflowGraph`: an `initialViewport` prop.)
 */
export function PhoneGraphCanvas({
  definition,
  steps,
  onNodeClick,
  onInteract,
  className,
}: {
  definition: WorkflowDefinition;
  steps?: WorkflowRunStep[];
  onNodeClick?: (nodeId: string) => void;
  /** First pan or zoom by the user, e.g. to dismiss a hint. */
  onInteract?: () => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const { nodes, edges } = useMemo(() => {
    const graph = toReactFlowGraph(definition, steps);
    return { nodes: applyDagreLayout(graph.nodes, graph.edges), edges: graph.edges };
  }, [definition, steps]);

  // `defaultViewport` is read once, so mount the flow only when the width is known
  // and re-mount it (re-opening at the start) when the definition changes shape.
  const shape = nodes.map((n) => n.id).join("|");

  return (
    <div ref={box} className={cn("min-h-0 min-w-0 touch-none", className)}>
      {width > 0 && (
        <Flow
          key={shape}
          nodes={nodes}
          edges={edges}
          width={width}
          onNodeClick={onNodeClick}
          onInteract={onInteract}
        />
      )}
    </div>
  );
}

function Flow({
  nodes,
  edges,
  width,
  onNodeClick,
  onInteract,
}: {
  nodes: Node<FlowNodeData>[];
  edges: Edge[];
  width: number;
  onNodeClick?: (nodeId: string) => void;
  onInteract?: () => void;
}) {
  const { theme } = useTheme();
  const [viewport] = useState(() => readableViewport(nodes, width));
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onNodeClick={(_event, node) => onNodeClick?.(node.id)}
      onMoveStart={(event) => {
        if (event) onInteract?.();
      }}
      defaultViewport={viewport}
      minZoom={0.05}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      colorMode={theme === "dark" ? "dark" : "light"}
    >
      <Background gap={16} size={1} />
    </ReactFlow>
  );
}

/** Fit-everything options for the phone's "fit" button. */
export const PHONE_FIT_OPTIONS = { padding: 0.08, duration: 250, minZoom: 0.05 } as const;
