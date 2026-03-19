import { Handle, type NodeProps, Position } from "@xyflow/react";
import { ListTodo, MessageSquare, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FlowNodeData } from "./graph-utils";
import { statusBorderColor } from "./node-styles";

const iconMap: Record<string, typeof ListTodo> = {
  "create-task": ListTodo,
  "send-message": MessageSquare,
  "delegate-to-agent": Users,
};

const ASYNC_TYPES = ["create-task", "delegate-to-agent"];

export function ActionNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const Icon = iconMap[d.nodeType] || ListTodo;
  const borderColor = d.stepStatus ? statusBorderColor[d.stepStatus] : "border-blue-500/50";
  const isAsync = ASYNC_TYPES.includes(d.nodeType);

  return (
    <div
      className={cn(
        "bg-card border-2 rounded-lg shadow-sm px-3 py-2 min-w-[240px] max-w-[280px]",
        borderColor,
        d.selected && "ring-2 ring-amber-500 ring-offset-1 ring-offset-background",
      )}
    >
      <Handle type="target" position={Position.Top} id="input" className="!bg-blue-500" />
      <div className="flex items-center gap-2">
        <div className="p-1 rounded bg-blue-500/10">
          <Icon className="h-4 w-4 text-blue-500" />
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
      <Handle type="source" position={Position.Bottom} id="default" className="!bg-blue-500" />
    </div>
  );
}
