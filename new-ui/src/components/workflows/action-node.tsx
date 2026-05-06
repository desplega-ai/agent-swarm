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
    border: "border-action-agent-task/50",
    bg: "bg-action-agent-task/10",
    text: "text-action-agent-task",
    handle: "!bg-action-agent-task",
    icon: Bot,
  },
  script: {
    border: "border-action-script/50",
    bg: "bg-action-script/10",
    text: "text-action-script",
    handle: "!bg-action-script",
    icon: Terminal,
  },
  notify: {
    border: "border-action-notify/50",
    bg: "bg-action-notify/10",
    text: "text-action-notify",
    handle: "!bg-action-notify",
    icon: Bell,
  },
  "human-in-the-loop": {
    border: "border-action-human-in-the-loop/50",
    bg: "bg-action-human-in-the-loop/10",
    text: "text-action-human-in-the-loop",
    handle: "!bg-action-human-in-the-loop",
    icon: UserCheck,
  },
  "create-task": {
    border: "border-action-create-task/50",
    bg: "bg-action-create-task/10",
    text: "text-action-create-task",
    handle: "!bg-action-create-task",
    icon: ListPlus,
  },
  "send-message": {
    border: "border-action-send-message/50",
    bg: "bg-action-send-message/10",
    text: "text-action-send-message",
    handle: "!bg-action-send-message",
    icon: MessageCircle,
  },
  "delegate-to-agent": {
    border: "border-action-delegate-to-agent/50",
    bg: "bg-action-delegate-to-agent/10",
    text: "text-action-delegate-to-agent",
    handle: "!bg-action-delegate-to-agent",
    icon: Share2,
  },
};

const defaultStyle: NodeStyle = {
  border: "border-action-default/50",
  bg: "bg-action-default/10",
  text: "text-action-default",
  handle: "!bg-action-default",
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
        d.selected && "ring-2 ring-status-active ring-offset-1 ring-offset-background",
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
