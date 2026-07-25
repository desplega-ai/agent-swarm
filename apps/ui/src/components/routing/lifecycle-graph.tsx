import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  MarkerType,
  type Node,
  type NodeProps,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bot,
  CheckCircle2,
  GitBranch,
  Hand,
  Inbox,
  Layers,
  type LucideIcon,
  PlusCircle,
  UserCog,
} from "lucide-react";
import { useMemo } from "react";
import type { RoutingEdgeKind, RoutingHandler, RoutingVia } from "@/api/types";
import { WorkflowNodeShell } from "@/components/shared/workflow-node-shell";
import { applyDagreLayout, type FlowNodeData } from "@/components/workflows/graph-utils";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

// The task lifecycle rendered as a static React-Flow map. Nothing here is
// fetched — the shape of the lifecycle is a constant; only the per-edge handler
// counts + error indicators come from `GET /api/routing/handlers`. Read-only:
// no pan-into-edit, no dragging, no connecting.

export type LifecycleEdgeKey =
  | "before_assign:creation"
  | "before_assign:delegation"
  | "before_assign:claim"
  | "before_assign:resume"
  | "before_assign:completion"
  | "prompt.compose";

export interface HookableEdgeMeta {
  key: LifecycleEdgeKey;
  /** Compact identifier shown on the edge badge + panel header. */
  label: string;
  /** Human title for the panel. */
  title: string;
  edge: RoutingEdgeKind;
  /** Only set for `task.before_assign` edges. */
  via?: RoutingVia;
  description: string;
}

/** Ordered so the page can iterate edges deterministically. */
export const LIFECYCLE_EDGE_KEYS: LifecycleEdgeKey[] = [
  "before_assign:creation",
  "before_assign:delegation",
  "before_assign:claim",
  "before_assign:resume",
  "before_assign:completion",
  "prompt.compose",
];

export const HOOKABLE_EDGES: Record<LifecycleEdgeKey, HookableEdgeMeta> = {
  "before_assign:creation": {
    key: "before_assign:creation",
    label: "before_assign · creation",
    title: "Creation routing",
    edge: "task.before_assign",
    via: "creation",
    description:
      "Runs when a freshly ingested task is created, before it is assigned or dropped into the pool.",
  },
  "before_assign:delegation": {
    key: "before_assign:delegation",
    label: "before_assign · delegation",
    title: "Delegation routing",
    edge: "task.before_assign",
    via: "delegation",
    description:
      "Runs when the lead delegates a subtask into the pool — the seeded continuity pin lives here.",
  },
  "before_assign:claim": {
    key: "before_assign:claim",
    label: "before_assign · claim",
    title: "Claim routing",
    edge: "task.before_assign",
    via: "claim",
    description: "Runs as a worker is about to claim a task from the pool.",
  },
  "before_assign:resume": {
    key: "before_assign:resume",
    label: "before_assign · resume",
    title: "Resume routing",
    edge: "task.before_assign",
    via: "resume",
    description: "Runs when a paused or recovered task is re-dispatched to a worker.",
  },
  "before_assign:completion": {
    key: "before_assign:completion",
    label: "before_assign · completion",
    title: "Completion routing",
    edge: "task.before_assign",
    via: "completion",
    description: "Runs as a task completes — the hook point for follow-up routing.",
  },
  "prompt.compose": {
    key: "prompt.compose",
    label: "prompt.compose",
    title: "Prompt compose",
    edge: "prompt.compose",
    description:
      "Runs when the worker prompt is composed, injecting per-task routing directives into the session.",
  },
};

/** True when `handler` is one of the handlers registered on `key`. */
export function handlerMatchesEdgeKey(handler: RoutingHandler, key: LifecycleEdgeKey): boolean {
  const meta = HOOKABLE_EDGES[key];
  if (handler.edge !== meta.edge) return false;
  // `prompt.compose` has no via dimension — every prompt-compose handler applies.
  if (meta.edge === "prompt.compose") return true;
  // A `task.before_assign` handler with no `via` matcher applies to every via.
  const via = handler.matcher?.via;
  return via === undefined || via === meta.via;
}

/**
 * Handlers registered on `key`, in the engine's execution order
 * (`ORDER BY priority, name` — ascending priority, then name).
 */
export function handlersForEdgeKey(
  handlers: RoutingHandler[],
  key: LifecycleEdgeKey,
): RoutingHandler[] {
  return handlers
    .filter((handler) => handlerMatchesEdgeKey(handler, key))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

interface LifecycleNodeDef {
  id: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
}

const LIFECYCLE_NODES: LifecycleNodeDef[] = [
  {
    id: "ingestion",
    title: "Ingestion",
    subtitle: "slack · github · linear · jira · mcp · schedule",
    icon: Inbox,
  },
  { id: "creation", title: "Creation", subtitle: "task created", icon: PlusCircle },
  { id: "lead", title: "Lead session", subtitle: "triage · delegation", icon: UserCog },
  { id: "pool", title: "Pool", subtitle: "unassigned queue", icon: Layers },
  { id: "claim", title: "Claim", subtitle: "worker picks up", icon: Hand },
  { id: "worker", title: "Worker session", subtitle: "execution", icon: Bot },
  { id: "completion", title: "Completion", subtitle: "task finished", icon: CheckCircle2 },
  { id: "followup", title: "Follow-up", subtitle: "resume · next tasks", icon: GitBranch },
];

type LifecycleEdgeVariant = "hookable" | "bus" | "plain";

interface LifecycleEdgeDef {
  id: string;
  source: string;
  target: string;
  variant: LifecycleEdgeVariant;
  label: string;
  edgeKey?: LifecycleEdgeKey;
}

const LIFECYCLE_EDGES: LifecycleEdgeDef[] = [
  { id: "e-ingest", source: "ingestion", target: "creation", variant: "plain", label: "ingest" },
  { id: "e-created", source: "creation", target: "lead", variant: "bus", label: "task.created" },
  {
    id: "e-creation",
    source: "creation",
    target: "pool",
    variant: "hookable",
    label: "creation",
    edgeKey: "before_assign:creation",
  },
  {
    id: "e-delegation",
    source: "lead",
    target: "pool",
    variant: "hookable",
    label: "delegation",
    edgeKey: "before_assign:delegation",
  },
  {
    id: "e-claim",
    source: "pool",
    target: "claim",
    variant: "hookable",
    label: "claim",
    edgeKey: "before_assign:claim",
  },
  {
    id: "e-resume",
    source: "pool",
    target: "worker",
    variant: "hookable",
    label: "resume",
    edgeKey: "before_assign:resume",
  },
  {
    id: "e-compose",
    source: "claim",
    target: "worker",
    variant: "hookable",
    label: "prompt.compose",
    edgeKey: "prompt.compose",
  },
  {
    id: "e-completion",
    source: "worker",
    target: "completion",
    variant: "hookable",
    label: "completion",
    edgeKey: "before_assign:completion",
  },
  {
    id: "e-followup",
    source: "completion",
    target: "followup",
    variant: "plain",
    label: "follow-up",
  },
];

interface LifecycleNodeData {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  [key: string]: unknown;
}
type LifecycleFlowNode = Node<LifecycleNodeData, "lifecycleNode">;

function LifecycleNode({ data }: NodeProps<LifecycleFlowNode>) {
  return (
    <WorkflowNodeShell
      icon={data.icon}
      label={data.title}
      nodeType={data.subtitle}
      borderClass="border-border"
      iconBgClass="bg-muted"
      iconClass="text-muted-foreground"
      handleClass="!bg-muted-foreground"
    />
  );
}

interface LifecycleEdgeData {
  variant: LifecycleEdgeVariant;
  label: string;
  edgeKey?: LifecycleEdgeKey;
  handlerCount: number;
  hasErrors: boolean;
  selected: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
}
type LifecycleFlowEdge = Edge<LifecycleEdgeData, "lifecycleEdge">;

function LifecycleEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<LifecycleFlowEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });
  const variant = data?.variant ?? "plain";
  const isHookable = variant === "hookable";
  const selected = !!data?.selected;
  const hasErrors = !!data?.hasErrors;
  const count = data?.handlerCount ?? 0;

  const stroke = hasErrors
    ? "var(--color-status-error)"
    : selected
      ? "var(--color-primary)"
      : "var(--color-border)";

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: variant === "bus" ? "4 4" : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {isHookable ? (
            <button
              type="button"
              onClick={data?.onSelect}
              aria-pressed={selected}
              className={cn(
                "pointer-events-auto flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[10px] shadow-sm transition-colors hover:bg-accent",
                selected ? "border-primary text-foreground" : "border-border text-muted-foreground",
              )}
            >
              <span className="font-medium">{data?.label}</span>
              <span
                className={cn(
                  "rounded-full px-1 tabular-nums",
                  count > 0 ? "bg-primary/10 text-primary" : "text-muted-foreground/70",
                )}
              >
                {count}
              </span>
              {hasErrors ? (
                <span className="size-1.5 rounded-full bg-status-error" aria-hidden />
              ) : null}
            </button>
          ) : (
            <span className="pointer-events-none rounded-full border border-dashed border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground/80">
              {data?.label}
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { lifecycleNode: LifecycleNode };
const edgeTypes = { lifecycleEdge: LifecycleEdge };

interface LifecycleGraphProps {
  handlers: RoutingHandler[];
  selectedEdgeKey: LifecycleEdgeKey | null;
  onSelectEdge: (key: LifecycleEdgeKey) => void;
  className?: string;
}

export function LifecycleGraph({
  handlers,
  selectedEdgeKey,
  onSelectEdge,
  className,
}: LifecycleGraphProps) {
  const { theme } = useTheme();

  const { nodes, edges } = useMemo(() => {
    const rfNodes: LifecycleFlowNode[] = LIFECYCLE_NODES.map(
      (node): LifecycleFlowNode => ({
        id: node.id,
        type: "lifecycleNode",
        position: { x: 0, y: 0 },
        data: { title: node.title, subtitle: node.subtitle, icon: node.icon },
      }),
    );

    // Reuse the workflow dagre/stair layout by mapping the lifecycle nodes into
    // its `FlowNodeData` shape (only id + edges drive positioning), then copy
    // the computed positions back onto the real nodes.
    const layoutInput: Node<FlowNodeData>[] = rfNodes.map((node) => ({
      id: node.id,
      type: "actionNode",
      position: { x: 0, y: 0 },
      data: { label: node.data.title, nodeType: "lifecycle", config: {}, outputPorts: [] },
    }));
    const layoutEdges: Edge[] = LIFECYCLE_EDGES.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    }));
    const laid = applyDagreLayout(layoutInput, layoutEdges);
    const posById = new Map(laid.map((node) => [node.id, node.position]));
    const positioned = rfNodes.map((node) => ({
      ...node,
      position: posById.get(node.id) ?? node.position,
    }));

    const rfEdges: LifecycleFlowEdge[] = LIFECYCLE_EDGES.map((edge): LifecycleFlowEdge => {
      const matched = edge.edgeKey ? handlersForEdgeKey(handlers, edge.edgeKey) : [];
      const hasErrors = matched.some((handler) => handler.stats.errors > 0);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "lifecycleEdge",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: "var(--color-muted-foreground)",
        },
        data: {
          variant: edge.variant,
          label: edge.label,
          edgeKey: edge.edgeKey,
          handlerCount: matched.length,
          hasErrors,
          selected: !!edge.edgeKey && edge.edgeKey === selectedEdgeKey,
          onSelect: edge.edgeKey ? () => onSelectEdge(edge.edgeKey as LifecycleEdgeKey) : undefined,
        },
      };
    });

    return { nodes: positioned, edges: rfEdges };
  }, [handlers, selectedEdgeKey, onSelectEdge]);

  return (
    <div className={cn("min-h-[460px] h-[560px] rounded-lg border bg-card", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onEdgeClick={(_event, edge) => {
          const key = (edge.data as LifecycleEdgeData | undefined)?.edgeKey;
          if (key) onSelectEdge(key);
        }}
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
