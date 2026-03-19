import { Handle, type NodeProps, Position } from "@xyflow/react";
import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FlowNodeData } from "./graph-utils";
import { statusBorderColor } from "./node-styles";

export function ConditionNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const borderColor = d.stepStatus ? statusBorderColor[d.stepStatus] : "border-amber-500/50";
  const ports = d.outputPorts.length > 0 ? d.outputPorts : ["default"];

  return (
    <div
      className={cn(
        "bg-card border-2 rounded-lg shadow-sm px-3 py-2 min-w-[240px] max-w-[280px]",
        borderColor,
        d.selected && "ring-2 ring-amber-500 ring-offset-1 ring-offset-background",
      )}
    >
      <Handle type="target" position={Position.Top} id="input" className="!bg-amber-500" />
      <div className="flex items-center gap-2">
        <div className="p-1 rounded bg-amber-500/10">
          <GitBranch className="h-4 w-4 text-amber-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{d.label}</div>
          <div className="text-[10px] text-muted-foreground uppercase">{d.nodeType}</div>
        </div>
      </div>
      {ports.length > 1 ? (
        <div className="flex justify-around mt-1">
          {ports.map((port, i) => (
            <div key={port} className="flex flex-col items-center">
              <span className="text-[9px] text-muted-foreground">{port}</span>
              <Handle
                type="source"
                position={Position.Bottom}
                id={port}
                className="!bg-amber-500"
                style={{ left: `${((i + 1) / (ports.length + 1)) * 100}%` }}
              />
            </div>
          ))}
        </div>
      ) : (
        <Handle type="source" position={Position.Bottom} id="default" className="!bg-amber-500" />
      )}
    </div>
  );
}
