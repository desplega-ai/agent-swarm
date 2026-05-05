import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Bell, Bot, ListPlus, MessageCircle, Share2, Terminal, UserCheck, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  "agent-task": {
    border: "border-violet-500/50",
    bg: "bg-violet-500/10",
    text: "text-violet-400",
    handle: "!bg-violet-500",
    icon: Bot,
  },
  script: {
    border: "border-cyan-500/50",
    bg: "bg-cyan-500/10",
    text: "text-cyan-400",
    handle: "!bg-cyan-500",
    icon: Terminal,
  },
  notify: {
    border: "border-teal-500/50",
    bg: "bg-teal-500/10",
    text: "text-teal-400",
    handle: "!bg-teal-500",
    icon: Bell,
  },
  "human-in-the-loop": {
    border: "border-orange-500/50",
    bg: "bg-orange-500/10",
    text: "text-orange-400",
    handle: "!bg-orange-500",
    icon: UserCheck,
  },
  "create-task": {
    border: "border-indigo-500/50",
    bg: "bg-indigo-500/10",
    text: "text-indigo-400",
    handle: "!bg-indigo-500",
    icon: ListPlus,
  },
  "send-message": {
    border: "border-pink-500/50",
    bg: "bg-pink-500/10",
    text: "text-pink-400",
    handle: "!bg-pink-500",
    icon: MessageCircle,
  },
  "delegate-to-agent": {
    border: "border-purple-500/50",
    bg: "bg-purple-500/10",
    text: "text-purple-400",
    handle: "!bg-purple-500",
    icon: Share2,
  },
};

const defaultStyle: NodeStyle = {
  border: "border-blue-500/50",
  bg: "bg-blue-500/10",
  text: "text-blue-400",
  handle: "!bg-blue-500",
  icon: Zap,
};

const ASYNC_TYPES = new Set(["agent-task", "create-task", "delegate-to-agent"]);

export function ActionNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const style = nodeStyleMap[d.nodeType] ?? defaultStyle;
  const Icon = style.icon;
  const borderColor = d.stepStatus ? statusBorderColor[d.stepStatus] : style.border;
  const isAsync = ASYNC_TYPES.has(d.nodeType);
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
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium truncate">{d.label}</span>
            {isAsync && (
              <Badge
                variant="outline"
                className="text-[8px] px-1 py-0 h-4 font-medium leading-none uppercase"
              >
                async
              </Badge>
            )}
          </div>
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
