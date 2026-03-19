import { Background, Controls, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";
import "@xyflow/react/dist/style.css";
import type { WorkflowDefinition, WorkflowRunStep } from "@/api/types";
import { cn } from "@/lib/utils";
import { ActionNode } from "./action-node";
import { ConditionNode } from "./condition-node";
import { applyDagreLayout, toReactFlowGraph } from "./graph-utils";
import { TriggerNode } from "./trigger-node";

const nodeTypes = {
  triggerNode: TriggerNode,
  conditionNode: ConditionNode,
  actionNode: ActionNode,
};

interface WorkflowGraphProps {
  definition: WorkflowDefinition;
  steps?: WorkflowRunStep[];
  onNodeClick?: (nodeId: string) => void;
  selectedNodeId?: string | null;
  className?: string;
}

export function WorkflowGraph({
  definition,
  steps,
  onNodeClick,
  selectedNodeId,
  className,
}: WorkflowGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const graph = toReactFlowGraph(definition, steps);
    // Mark selected node
    if (selectedNodeId) {
      for (const node of graph.nodes) {
        if (node.id === selectedNodeId) {
          node.data = { ...node.data, selected: true };
        }
      }
    }
    const layoutNodes = applyDagreLayout(graph.nodes, graph.edges);
    return { nodes: layoutNodes, edges: graph.edges };
  }, [definition, steps, selectedNodeId]);

  return (
    <div className={cn("min-h-[400px] h-[500px] rounded-lg border bg-card", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_event, node) => onNodeClick?.(node.id)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
