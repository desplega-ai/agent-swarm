import type { ScriptRunKind } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const KIND_CONFIG: Record<ScriptRunKind, { label: string; className: string }> = {
  workflow: { label: "WORKFLOW", className: "border-action-script/50 text-action-script" },
  inline: { label: "INLINE", className: "border-status-info/30 text-status-info-strong" },
};

export function ScriptRunKindBadge({
  kind,
  className,
}: {
  kind: ScriptRunKind;
  className?: string;
}) {
  const config = KIND_CONFIG[kind] ?? KIND_CONFIG.workflow;
  return (
    <Badge variant="outline" size="tag" className={cn(config.className, className)}>
      {config.label}
    </Badge>
  );
}
