import { useMemo } from "react";
import type { WorkflowDefinition } from "@/api/types";
import { MobileListRow } from "@/components/shared/mobile-list";
import { Badge } from "@/components/ui/badge";
import {
  applyDagreLayout,
  getNodeLabel,
  toReactFlowGraph,
} from "@/components/workflows/graph-utils";

/**
 * The definition as a top-to-bottom list, in the order the graph reads. A
 * 45-node graph is 6000px of canvas on a phone; this is the same nodes as
 * tappable rows (tap opens the inspector sheet), with the branch ports on
 * the row of the node that forks.
 */
export function PhoneStepsList({
  definition,
  selectedNodeId,
  onSelect,
}: {
  definition: WorkflowDefinition;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const rows = useMemo(() => {
    const graph = toReactFlowGraph(definition);
    const laid = applyDagreLayout(graph.nodes, graph.edges);
    const byId = new Map(definition.nodes.map((n) => [n.id, n]));
    return laid
      .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, ports: n.data.outputPorts }))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .flatMap((r) => {
        const node = byId.get(r.id);
        return node ? [{ ...r, node }] : [];
      });
  }, [definition]);

  return (
    <ul className="min-h-0 flex-1 divide-y divide-border-subtle overflow-y-auto" aria-label="Steps">
      {rows.map(({ id, node, ports }, index) => {
        const branches = ports.filter((p) => p !== "default");
        return (
          <MobileListRow
            key={id}
            onClick={() => onSelect(id)}
            selected={id === selectedNodeId}
            title={getNodeLabel(node)}
            titleLines={2}
            leading={
              <span className="relative flex size-6 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums text-muted-foreground">
                {index + 1}
              </span>
            }
            status={
              <Badge variant="outline" size="tag" className="font-mono uppercase">
                {node.type}
              </Badge>
            }
            meta={[branches.length > 0 ? `branches: ${branches.join(" / ")}` : null]}
          />
        );
      })}
    </ul>
  );
}
