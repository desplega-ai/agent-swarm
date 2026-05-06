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
    border: "border-action-property-match/50",
    bg: "bg-action-property-match/10",
    text: "text-action-property-match",
    handle: "!bg-action-property-match",
    icon: Filter,
  },
  "code-match": {
    border: "border-action-code-match/50",
    bg: "bg-action-code-match/10",
    text: "text-action-code-match",
    handle: "!bg-action-code-match",
    icon: Code2,
  },
  // `validate` reuses `human-in-the-loop` per audit doc decision §g #6 —
  // both render orange and disambiguating them in tokens added no value.
  validate: {
    border: "border-action-human-in-the-loop/50",
    bg: "bg-action-human-in-the-loop/10",
    text: "text-action-human-in-the-loop",
    handle: "!bg-action-human-in-the-loop",
    icon: ShieldCheck,
  },
  "raw-llm": {
    border: "border-action-raw-llm/50",
    bg: "bg-action-raw-llm/10",
    text: "text-action-raw-llm",
    handle: "!bg-action-raw-llm",
    icon: Sparkles,
  },
};

const defaultStyle: NodeStyle = {
  border: "border-action-property-match/50",
  bg: "bg-action-property-match/10",
  text: "text-action-property-match",
  handle: "!bg-action-property-match",
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
        d.selected && "ring-2 ring-status-active ring-offset-1 ring-offset-background",
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
                // inline-style: react-flow port position computed per index
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
