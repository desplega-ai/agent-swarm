import type { ScriptRunKind } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const KIND_CONFIG: Record<ScriptRunKind, { label: string; className: string }> = {
  workflow: { label: "WORKFLOW", className: "border-action-script/50 text-action-script" },
  inline: { label: "INLINE", className: "border-status-info/30 text-status-info-strong" },
};

/** An object call on a durable script; matches `DurableBadge`. */
const OBJECT_CONFIG = { label: "OBJECT", className: "border-foreground/30 text-foreground" };

export function ScriptRunKindBadge({
  kind,
  object = false,
  className,
}: {
  kind: ScriptRunKind;
  /** The run called a durable object method. */
  object?: boolean;
  className?: string;
}) {
  const config = object ? OBJECT_CONFIG : (KIND_CONFIG[kind] ?? KIND_CONFIG.workflow);
  return (
    <Badge variant="outline" size="tag" className={cn(config.className, className)}>
      {config.label}
    </Badge>
  );
}
