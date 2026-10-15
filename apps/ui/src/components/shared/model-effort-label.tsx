import type { ReasoningEffortLevel } from "@/api/types";
import type { LiveModelsCatalog } from "@/lib/agent-runtime-models";
import { cn } from "@/lib/utils";
import { EffortMark } from "./effort-mark";
import { ModelLabel } from "./model-logo";

/**
 * A model with its reasoning effort: logo, display name, then the effort's
 * signal icon. The one way a model is shown in the dashboard, so every surface
 * (task list, task detail, agent list, agent detail) reads the same.
 */
export function ModelEffortLabel({
  model,
  effort,
  catalog,
  className,
  effortClassName = "text-muted-foreground",
  title,
}: {
  model: string;
  effort?: ReasoningEffortLevel | null;
  catalog?: LiveModelsCatalog;
  className?: string;
  effortClassName?: string;
  /** Native hover text, for surfaces without a tooltip (e.g. the raw model id). */
  title?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={title}>
      <ModelLabel model={model} catalog={catalog} />
      <EffortMark effort={effort} className={effortClassName} />
    </span>
  );
}
