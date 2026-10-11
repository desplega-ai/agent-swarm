import type { NodeProps } from "@xyflow/react";
import {
  Bell,
  Bot,
  BrainCircuit,
  Library,
  ListPlus,
  type LucideIcon,
  MessageCircle,
  Repeat,
  Share2,
  Terminal,
  UserCheck,
  Workflow,
  Zap,
} from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useExecutorTypes, useWorkflows } from "@/api/hooks/use-workflows";
import { WorkflowNodeShell } from "@/components/shared/workflow-node-shell";
import { Badge } from "@/components/ui/badge";
import type { FlowNodeData } from "./graph-utils";
import { statusBorderColor } from "./node-styles";
import { subWorkflowTargetId, systemOneSummary } from "./node-summary";

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
  foreach: {
    border: "border-action-foreach/50",
    bg: "bg-action-foreach/10",
    text: "text-action-foreach",
    handle: "!bg-action-foreach",
    icon: Repeat,
  },
  "swarm-script": {
    border: "border-action-swarm-script/50",
    bg: "bg-action-swarm-script/10",
    text: "text-action-swarm-script",
    handle: "!bg-action-swarm-script",
    icon: Library,
  },
  "sub-workflow": {
    border: "border-action-sub-workflow/50",
    bg: "bg-action-sub-workflow/10",
    text: "text-action-sub-workflow",
    handle: "!bg-action-sub-workflow",
    icon: Workflow,
  },
  "system-one-decision": {
    border: "border-action-system-one-decision/50",
    bg: "bg-action-system-one-decision/10",
    text: "text-action-system-one-decision",
    handle: "!bg-action-system-one-decision",
    icon: BrainCircuit,
  },
};

const defaultStyle: NodeStyle = {
  border: "border-action-default/50",
  bg: "bg-action-default/10",
  text: "text-action-default",
  handle: "!bg-action-default",
  icon: Zap,
};

/** Node type → executor mode, from the API, so the card agrees with the node inspector. */
function useAsyncTypes(): Set<string> {
  const { data } = useExecutorTypes();
  return useMemo(
    () => new Set((data ?? []).filter((t) => t.mode === "async").map((t) => t.type)),
    [data],
  );
}

/** The name of the workflow a `sub-workflow` node runs, linked to its definition. */
function SubWorkflowTarget({ workflowId }: { workflowId: string }) {
  const { data: workflows } = useWorkflows();
  const name = workflows?.find((w) => w.id === workflowId)?.name;
  return (
    <Link
      to={`/workflows/${workflowId}`}
      // nodrag/nopan: let the click through to the link instead of starting a pan.
      className="nodrag nopan hover:underline hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
      title={workflowId}
    >
      &rarr; {name ?? `${workflowId.slice(0, 8)}…`}
    </Link>
  );
}

function nodeSubtitle(d: FlowNodeData) {
  if (d.nodeType === "sub-workflow") {
    const workflowId = subWorkflowTargetId(d.config);
    return workflowId ? <SubWorkflowTarget workflowId={workflowId} /> : undefined;
  }
  if (d.nodeType === "system-one-decision") return systemOneSummary(d.config);
  return undefined;
}

export function ActionNode({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const style = nodeStyleMap[d.nodeType] ?? defaultStyle;
  const borderClass = d.stepStatus ? statusBorderColor[d.stepStatus] : style.border;
  const isAsync = useAsyncTypes().has(d.nodeType);

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
      subtitle={nodeSubtitle(d)}
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
