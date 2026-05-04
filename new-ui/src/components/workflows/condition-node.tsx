import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Code2, Filter, ShieldCheck, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FlowNodeData } from "./graph-utils";
import { statusBorderColor } from "./node-styles";

type NodeStyle = {
  border: string;
  bg: string;
  text: string;
  handle: string;
  icon: React.ElementType;
};

const nodeStyleMap: Record<string, NodeStyle> = {
  "property-match": {
    border: "border-amber-500/50",
    bg: "bg-amber-500/10",
    text: "text-amber-500",
    handle: "!bg-amber-500",
    icon: Filter,
  },
  "code-match": {
    border: "border-yellow-500/50",
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    handle: "!bg-yellow-500",
    icon: Code2,
  },
  validate: {
    border: "border-orange-500/50",
    bg: "bg-orange-500/10",
    text: "text-orange-400",
    handle: "!bg-orange-500",
    icon: ShieldCheck,
  },
  "raw-llm": {
    border: "border-sky-500/50",
    bg: "bg-sky-500/10",
    text: "text-sky-400",
    handle: "!bg-sky-500",
    icon: Sparkles,
  },
};

const defaultStyle: NodeStyle = {
  border: "border-amber-500/50",
  bg: "bg-amber-500/10",
  text: "text-amber-500",
  handle: "!bg-amber-500",
  icon: Filter,
};

export function ConditionNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const style = nodeStyleMap[d.nodeType] ?? defaultStyle;
  const Icon = style.icon;
  const borderColor = d.stepStatus ? statusBorderColor[d.stepStatus] : style.border;
  const ports = d.outputPorts.length > 0 ? d.outputPorts : ["default"];

  return (
    <div
      className={cn(
        "bg-card border-2 rounded-lg shadow-sm px-3 py-2 min-w-[240px] max-w-[280px]",
        borderColor,
        d.selected && "ring-2 ring-amber-500 ring-offset-1 ring-offset-background",
      )}
    >
      <Handle type="target" position={Position.Top} id="input" className={style.handle} />
      <div className="flex items-center gap-2">
        <div className={cn("p-1 rounded", style.bg)}>
          <Icon className={cn("h-4 w-4", style.text)} />
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
                className={style.handle}
                style={{ left: `${((i + 1) / (ports.length + 1)) * 100}%` }}
              />
            </div>
          ))}
        </div>
      ) : (
        <Handle type="source" position={Position.Bottom} id="default" className={style.handle} />
      )}
    </div>
  );
}
