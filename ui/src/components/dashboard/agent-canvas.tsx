import { Background, Controls, type Edge, MarkerType, type Node, ReactFlow } from "@xyflow/react";
import dagre from "dagre";
import { Bot } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import "@xyflow/react/dist/style.css";
import {
  type AgentActivityRow,
  computeActivityScores,
  MAX_NODE_HEIGHT,
  MAX_NODE_WIDTH,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  nodeSizeFromScore,
} from "@/api/hooks/use-agent-activity";
import { EmptyState } from "@/components/shared/empty-state";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { AgentNode, type AgentNodeData } from "./agent-node";

// Phase 5: dashboard agent canvas (≥1.76.0).
//
// Renders agents as a static org-chart: lead at the top, workers fanning out
// below. Reuses the workflow-graph pattern (xyflow + dagre) — see
// `workflow-graph.tsx` and `graph-utils.ts:applyDagreLayout`. We can't use
// `applyDagreLayout` directly because it's hard-coded to a 280×80 node size
// and the `FlowNodeData` shape; the canvas runs its own dagre pass tuned for
// per-node-size variability driven by 24h activity score.
//
// Performance: dagre is O(N+E) and xyflow renders a flat node list — both are
// fine well past the 50-node target the PRD calls out. No animations, no
// `nodesDraggable`, no `nodesConnectable`.

const nodeTypes = { agentNode: AgentNode };

interface AgentCanvasProps {
  rows: AgentActivityRow[];
  className?: string;
  /**
   * Full-bleed variant — fills the parent's height with no border, radius, or
   * card background. Requires a definite-height parent (see `UnifiedHome`).
   * When false (default) the canvas renders as a clamped-height bordered card.
   */
  fullBleed?: boolean;
}

interface LayoutResult {
  nodes: Node<AgentNodeData>[];
  edges: Edge[];
}

function buildLayout(rows: AgentActivityRow[]): LayoutResult {
  if (rows.length === 0) return { nodes: [], edges: [] };

  // Lead detection — first agent flagged isLead. The schema permits at most
  // one lead per swarm but we tolerate zero (in which case all agents render
  // as a single rank with no edges).
  const lead = rows.find((r) => r.agent.isLead);
  const workers = rows.filter((r) => r !== lead);

  const scores = computeActivityScores(rows);

  // Sized node descriptors keyed by agent id. The lead is pinned to the
  // baseline (min) size so its box stays dimensionally consistent with the
  // worker nodes — the lead naturally scores highest on 24h activity and would
  // otherwise balloon to the max size. Visual emphasis comes from the crown
  // icon + accent handle, not an oversized box. Keeping it at the min size
  // also keeps the dagre layout (which reads these same dimensions) correct.
  const sized = new Map<string, { width: number; height: number; row: AgentActivityRow }>();
  for (const r of rows) {
    if (r === lead) {
      sized.set(r.agent.id, { width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT, row: r });
      continue;
    }
    const score = scores.get(r.agent.id) ?? 0;
    sized.set(r.agent.id, { ...nodeSizeFromScore(score), row: r });
  }

  // Run dagre with per-node sizes (rankdir TB for top-down org chart).
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 80 });
  for (const [id, s] of sized) {
    g.setNode(id, { width: s.width, height: s.height });
  }

  const edges: Edge[] = [];
  if (lead) {
    for (const w of workers) {
      g.setEdge(lead.agent.id, w.agent.id);
      edges.push({
        id: `${lead.agent.id}->${w.agent.id}`,
        source: lead.agent.id,
        target: w.agent.id,
        sourceHandle: "default",
        targetHandle: "input",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: "currentColor",
        },
      });
    }
  }

  dagre.layout(g);

  const nodes: Node<AgentNodeData>[] = rows.map((r) => {
    const s = sized.get(r.agent.id);
    if (!s) {
      // Should not happen — defensive fallback to the min-size box.
      return {
        id: r.agent.id,
        type: "agentNode",
        position: { x: 0, y: 0 },
        data: {
          agent: r.agent,
          taskCount24h: r.taskCount24h,
          cost24h: r.cost24h,
          width: MAX_NODE_WIDTH,
          height: MAX_NODE_HEIGHT,
          isLead: !!r.agent.isLead,
        },
      };
    }
    const pos = g.node(r.agent.id);
    return {
      id: r.agent.id,
      type: "agentNode",
      position: {
        x: (pos?.x ?? 0) - s.width / 2,
        y: (pos?.y ?? 0) - s.height / 2,
      },
      data: {
        agent: r.agent,
        taskCount24h: r.taskCount24h,
        cost24h: r.cost24h,
        width: s.width,
        height: s.height,
        isLead: !!r.agent.isLead,
      },
    };
  });

  return { nodes, edges };
}

export function AgentCanvas({ rows, className, fullBleed }: AgentCanvasProps) {
  const { theme } = useTheme();
  const navigate = useNavigate();

  const { nodes, edges } = useMemo(() => buildLayout(rows), [rows]);

  const sizeClasses = fullBleed
    ? "h-full"
    : "h-[clamp(280px,38vh,460px)] rounded-lg border bg-card";

  if (rows.length === 0) {
    return (
      <div className={cn(sizeClasses, "flex items-center justify-center", className)}>
        <EmptyState
          icon={Bot}
          title="No agents connected"
          description="Start a worker (e.g. `bun run pm2-start`) to see it appear here."
        />
      </div>
    );
  }

  return (
    <div className={cn(sizeClasses, className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_event, node) => navigate(`/agents/${node.id}`)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        colorMode={theme === "dark" ? "dark" : "light"}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
