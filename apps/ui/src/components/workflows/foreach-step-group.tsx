import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { WorkflowNode, WorkflowRunStep } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { effectiveChildStatus } from "@/components/workflows/graph-utils";
import { StepCard } from "@/components/workflows/step-card";

/** Children rendered before the "Show all N items" escape hatch kicks in. */
const CHILD_PAGE_SIZE = 50;

export interface ForeachStepGroupProps {
  parent: WorkflowRunStep;
  childSteps: WorkflowRunStep[];
  workflowNodes?: WorkflowNode[];
  selectedNodeId: string | null;
  isOpen: boolean;
  onToggleOpen: () => void;
  expandedStepIds: ReadonlySet<string>;
  onStepClick: (nodeId: string) => void;
  onToggleStepExpand: (nodeId: string) => void;
  registerStepRef: (nodeId: string, el: HTMLDivElement | null) => void;
}

/** Aggregate counts across a `foreach`'s children, using the same failure semantics as the graph. */
export function foreachChildSummary(childSteps: WorkflowRunStep[]): {
  total: number;
  ok: number;
  failed: number;
  hasPending: boolean;
} {
  let ok = 0;
  let failed = 0;
  let hasPending = false;
  for (const step of childSteps) {
    const status = effectiveChildStatus(step);
    if (status === "completed") ok++;
    else if (status === "failed") failed++;
    if (status === "pending" || status === "running" || status === "waiting") hasPending = true;
  }
  return { total: childSteps.length, ok, failed, hasPending };
}

/** Whether a group starts open: anything failed or still in flight deserves attention. */
export function foreachDefaultOpen(childSteps: WorkflowRunStep[]): boolean {
  const { failed, hasPending } = foreachChildSummary(childSteps);
  return failed > 0 || hasPending;
}

/**
 * A `foreach` parent step plus its synthetic children, rendered as a nested accordion: the parent
 * card keeps its own details chevron (level 2) while the caret row below toggles the children list.
 */
export function ForeachStepGroup({
  parent,
  childSteps,
  workflowNodes,
  selectedNodeId,
  isOpen,
  onToggleOpen,
  expandedStepIds,
  onStepClick,
  onToggleStepExpand,
  registerStepRef,
}: ForeachStepGroupProps) {
  const [showAll, setShowAll] = useState(false);
  const summary = foreachChildSummary(childSteps);
  const visibleChildren = showAll ? childSteps : childSteps.slice(0, CHILD_PAGE_SIZE);
  const hiddenCount = childSteps.length - visibleChildren.length;

  return (
    <div className="space-y-1.5">
      <StepCard
        step={parent}
        workflowNodes={workflowNodes}
        isSelected={selectedNodeId === parent.nodeId}
        isExpanded={expandedStepIds.has(parent.nodeId)}
        onClick={() => onStepClick(parent.nodeId)}
        onToggleExpand={() => onToggleStepExpand(parent.nodeId)}
        ref={(el) => registerStepRef(parent.nodeId, el)}
      />

      <div className="pl-3 space-y-1.5">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={isOpen ? "Hide items" : "Show items"}
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <Badge variant="outline" size="tag">
            {summary.total} item{summary.total !== 1 ? "s" : ""}
          </Badge>
          <span>&middot; {summary.ok} ok</span>
          {summary.failed > 0 && (
            <span className="text-status-error-strong">&middot; {summary.failed} failed</span>
          )}
        </button>

        {isOpen && (
          <div className="pl-3 border-l border-border/50 space-y-1.5">
            {visibleChildren.map((step) => (
              <StepCard
                key={step.id}
                step={step}
                workflowNodes={workflowNodes}
                isSelected={selectedNodeId === step.nodeId || selectedNodeId === parent.nodeId}
                isExpanded={expandedStepIds.has(step.nodeId)}
                onClick={() => onStepClick(step.nodeId)}
                onToggleExpand={() => onToggleStepExpand(step.nodeId)}
                inGroup
                ref={(el) => registerStepRef(step.nodeId, el)}
              />
            ))}
            {hiddenCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground"
                onClick={() => setShowAll(true)}
              >
                Show all {childSteps.length} items
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
