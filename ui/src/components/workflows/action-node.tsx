import type { NodeProps } from "@xyflow/react";
import {
  Bell,
  Bot,
  ListPlus,
  type LucideIcon,
  MessageCircle,
  Share2,
  Terminal,
  UserCheck,
  Zap,
} from "lucide-react";
import { WorkflowNodeShell } from "@/components/shared/workflow-node-shell";
import { Badge } from "@/components/ui/badge";
import type { FlowNodeData } from "./graph-utils";
import { statusBorderColor } from "./node-styles";

type NodeStyle = {
  border: string;
  bg: string;
  text: string;
  handle: string;
  icon: LucideIcon;
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
  const borderClass = d.stepStatus ? statusBorderColor[d.stepStatus] : style.border;
  const isAsync = ASYNC_TYPES.has(d.nodeType);

  return (
    <WorkflowNodeShell
      icon={style.icon}
      label={d.label}
      nodeType={d.nodeType}
      borderClass={borderClass}
      iconBgClass={style.bg}
      iconClass={style.text}
      handleClass={style.handle}
      selected={d.selected}
      outputPorts={d.outputPorts}
      badge={
        isAsync ? (
          <Badge
            variant="outline"
            className="text-[8px] px-1 py-0 h-4 font-medium leading-none uppercase"
          >
            async
          </Badge>
        ) : undefined
      }
    />
  );
}
