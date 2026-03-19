import { Handle, type NodeProps, Position } from "@xyflow/react";
import { GitBranch, Globe, ListTodo, Mail, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FlowNodeData } from "./graph-utils";
import { statusBorderColor } from "./node-styles";

const iconMap: Record<string, typeof ListTodo> = {
  "trigger-new-task": ListTodo,
  "trigger-task-completed": ListTodo,
  "trigger-webhook": Globe,
  "trigger-email": Mail,
  "trigger-slack-message": MessageSquare,
  "trigger-github-event": GitBranch,
};

export function TriggerNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const Icon = iconMap[d.nodeType] || ListTodo;
  const borderColor = d.stepStatus ? statusBorderColor[d.stepStatus] : "border-emerald-500/50";

  return (
    <div
      className={cn(
        "bg-card border-2 rounded-lg shadow-sm px-3 py-2 min-w-[240px] max-w-[280px]",
        borderColor,
        d.selected && "ring-2 ring-amber-500 ring-offset-1 ring-offset-background",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="p-1 rounded bg-emerald-500/10">
          <Icon className="h-4 w-4 text-emerald-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{d.label}</div>
          <div className="text-[10px] text-muted-foreground uppercase">{d.nodeType}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} id="default" className="!bg-emerald-500" />
    </div>
  );
}
