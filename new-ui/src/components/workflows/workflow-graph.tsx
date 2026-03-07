import { Background, Controls, MiniMap, ReactFlow } from "@xyflow/react";
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
  className?: string;
}

export function WorkflowGraph({ definition, steps, onNodeClick, className }: WorkflowGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const graph = toReactFlowGraph(definition, steps);
    const layoutNodes = applyDagreLayout(graph.nodes, graph.edges);
    return { nodes: layoutNodes, edges: graph.edges };
  }, [definition, steps]);

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
        <MiniMap
          nodeColor={() => "var(--color-muted-foreground)"}
          className="!bg-muted !border-border"
        />
      </ReactFlow>
    </div>
  );
}
