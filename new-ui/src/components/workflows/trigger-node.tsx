import type { NodeProps } from "@xyflow/react";
import {
  Clock,
  Globe,
  ListTodo,
  type LucideIcon,
  Mail,
  MessageSquare,
  Webhook,
} from "lucide-react";
import { WorkflowNodeShell } from "@/components/shared/workflow-node-shell";
import type { FlowNodeData } from "./graph-utils";
import { statusBorderColor } from "./node-styles";

const iconMap: Record<string, LucideIcon> = {
  "trigger-new-task": ListTodo,
  "trigger-task-completed": ListTodo,
  "trigger-webhook": Webhook,
  "trigger-email": Mail,
  "trigger-slack-message": MessageSquare,
  "trigger-github-event": Globe,
  "trigger-schedule": Clock,
};

export function TriggerNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const Icon = iconMap[d.nodeType] ?? ListTodo;
  const borderClass = d.stepStatus ? statusBorderColor[d.stepStatus] : "border-status-success/50";

  return (
    <WorkflowNodeShell
      icon={Icon}
      label={d.label}
      nodeType={d.nodeType}
      borderClass={borderClass}
      iconBgClass="bg-status-success/10"
      iconClass="text-status-success"
      handleClass="!bg-status-success"
      selected={d.selected}
      showTargetHandle={false}
      outputPorts={["default"]}
    />
  );
}
