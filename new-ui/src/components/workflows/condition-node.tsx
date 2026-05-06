import type { NodeProps } from "@xyflow/react";
import { Code2, Filter, type LucideIcon, ShieldCheck, Sparkles } from "lucide-react";
import { WorkflowNodeShell } from "@/components/shared/workflow-node-shell";
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
  const borderClass = d.stepStatus ? statusBorderColor[d.stepStatus] : style.border;

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
    />
  );
}
