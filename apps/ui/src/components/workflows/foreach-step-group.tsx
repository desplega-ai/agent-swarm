import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { WorkflowDefinition, WorkflowNode, WorkflowRunStep } from "@/api/types";
import { ProgressRing } from "@/components/shared/task-status-icon";
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
  onNodeFailure?: WorkflowDefinition["onNodeFailure"];
  selectedNodeId: string | null;
  isOpen: boolean;
  onToggleOpen: () => void;
  expandedStepIds: ReadonlySet<string>;
  onStepClick: (nodeId: string) => void;
  onToggleStepExpand: (nodeId: string) => void;
  registerStepRef: (nodeId: string, el: HTMLDivElement | null) => void;
}

/** One foreach item: its latest attempt row plus the earlier attempts, oldest first. */
export interface ForeachItemAttempts {
  latest: WorkflowRunStep;
  earlier: WorkflowRunStep[];
}

function inputNumber(step: WorkflowRunStep, field: "index" | "attempt"): number | undefined {
  if (typeof step.input !== "object" || step.input === null) return undefined;
  const value = (step.input as Record<string, unknown>)[field];
  return typeof value === "number" ? value : undefined;
}

/**
 * Group a foreach's child rows by item. A run retry adds a new attempt row for each failed or
 * cancelled item under the same synthetic node id, so the latest attempt is the item's outcome and
 * the earlier rows are history. Attempts sort by `input.attempt` (row order for legacy rows without
 * it); items sort by `input.index`, as the server's join does.
 */
export function groupForeachAttempts(childSteps: WorkflowRunStep[]): ForeachItemAttempts[] {
  const byItem = new Map<string, WorkflowRunStep[]>();
  for (const step of childSteps) {
    const rows = byItem.get(step.nodeId);
    if (rows) rows.push(step);
    else byItem.set(step.nodeId, [step]);
  }
  const items = [...byItem.values()].map((rows) => {
    const ordered = rows
      .map((step, order) => ({ step, order, attempt: inputNumber(step, "attempt") ?? order }))
      .sort((a, b) => a.attempt - b.attempt || a.order - b.order)
      .map(({ step }) => step);
    return { latest: ordered[ordered.length - 1]!, earlier: ordered.slice(0, -1) };
  });
  const index = (item: ForeachItemAttempts) =>
    inputNumber(item.latest, "index") ?? Number.MAX_SAFE_INTEGER;
  return items.sort((a, b) => index(a) - index(b));
}

/**
 * Aggregate counts across a `foreach`'s items, latest attempt only, using the same failure
 * semantics as the graph. `queued` items have not started (`pending`); `running` items are in
 * flight (`running` or `waiting`), which is what the concurrency cap bounds.
 */
export function foreachChildSummary(childSteps: WorkflowRunStep[]): {
  total: number;
  ok: number;
  failed: number;
  queued: number;
  running: number;
  hasPending: boolean;
} {
  let ok = 0;
  let failed = 0;
  let queued = 0;
  let running = 0;
  const items = groupForeachAttempts(childSteps);
  for (const { latest } of items) {
    const status = effectiveChildStatus(latest);
    if (status === "completed") ok++;
    else if (status === "failed") failed++;
    else if (status === "pending") queued++;
    else if (status === "running" || status === "waiting") running++;
  }
  return { total: items.length, ok, failed, queued, running, hasPending: queued + running > 0 };
}

/** Whether a group starts open: anything failed or still in flight deserves attention. */
export function foreachDefaultOpen(childSteps: WorkflowRunStep[]): boolean {
  const { failed, hasPending } = foreachChildSummary(childSteps);
  return failed > 0 || hasPending;
}

/**
 * How a failed or cancelled item affects the fan-out. Mirrors the server's
 * `effectiveFailurePolicy`: `config.failurePolicy` wins, otherwise the workflow's `onNodeFailure`
 * decides (`"continue"` collects outcomes, the default `"fail"` is fail-fast).
 */
export function foreachFailurePolicy(
  node: WorkflowNode | undefined,
  onNodeFailure: WorkflowDefinition["onNodeFailure"],
): "fail-fast" | "collect-outcomes" {
  const configured = node?.config.failurePolicy;
  if (configured === "fail-fast" || configured === "collect-outcomes") return configured;
  return onNodeFailure === "continue" ? "collect-outcomes" : "fail-fast";
}

/** The fan-out's concurrency cap, or undefined when unbounded (the default). */
export function foreachConcurrencyCap(node: WorkflowNode | undefined): number | undefined {
  const cap = node?.config.concurrency;
  return typeof cap === "number" && Number.isInteger(cap) && cap >= 1 ? cap : undefined;
}

/**
 * A `foreach` parent step plus its synthetic children, rendered as a nested accordion: the parent
 * card keeps its own details chevron (level 2) while the caret row below toggles the items list.
 * Each item renders its latest attempt; earlier attempts sit behind a disclosure in its card.
 */
export function ForeachStepGroup({
  parent,
  childSteps,
  workflowNodes,
  onNodeFailure,
  selectedNodeId,
  isOpen,
  onToggleOpen,
  expandedStepIds,
  onStepClick,
  onToggleStepExpand,
  registerStepRef,
}: ForeachStepGroupProps) {
  const [showAll, setShowAll] = useState(false);
  const items = groupForeachAttempts(childSteps);
  const summary = foreachChildSummary(childSteps);
  const node = workflowNodes?.find((n) => n.id === parent.nodeId);
  const policy = foreachFailurePolicy(node, onNodeFailure);
  const cap = foreachConcurrencyCap(node);
  const visibleItems = showAll ? items : items.slice(0, CHILD_PAGE_SIZE);
  const hiddenCount = items.length - visibleItems.length;

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
          className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={isOpen ? "Hide items" : "Show items"}
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <ProgressRing
            done={summary.ok}
            total={summary.total}
            label={`${summary.ok} of ${summary.total} items ok`}
            className="size-3.5"
          />
          <Badge variant="outline" size="tag">
            {summary.total} item{summary.total !== 1 ? "s" : ""}
          </Badge>
          <span>&middot; {summary.ok} ok</span>
          {summary.failed > 0 && (
            <span className="text-status-error-strong">&middot; {summary.failed} failed</span>
          )}
          {summary.queued > 0 && <span>&middot; {summary.queued} queued</span>}
          {/* In flight against the cap; an unbounded fan-out (the default) has no cap to show. */}
          {cap !== undefined && summary.hasPending && (
            <span>
              &middot; {summary.running} running / {cap}
            </span>
          )}
          <Badge
            variant="outline"
            size="tag"
            title="What a failed or cancelled item does to the rest of the fan-out"
          >
            {policy}
          </Badge>
        </button>

        {isOpen && (
          <div className="pl-3 border-l border-border/50 space-y-1.5">
            {visibleItems.map(({ latest, earlier }) => (
              <StepCard
                key={latest.id}
                step={latest}
                earlierAttempts={earlier}
                workflowNodes={workflowNodes}
                isSelected={selectedNodeId === latest.nodeId || selectedNodeId === parent.nodeId}
                isExpanded={expandedStepIds.has(latest.nodeId)}
                onClick={() => onStepClick(latest.nodeId)}
                onToggleExpand={() => onToggleStepExpand(latest.nodeId)}
                inGroup
                ref={(el) => registerStepRef(latest.nodeId, el)}
              />
            ))}
            {hiddenCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground"
                onClick={() => setShowAll(true)}
              >
                Show all {items.length} items
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
