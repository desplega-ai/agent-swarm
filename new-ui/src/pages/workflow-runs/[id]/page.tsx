import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  RefreshCw,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useRetryWorkflowRun, useWorkflow, useWorkflowRun } from "@/api/hooks/use-workflows";
import type { WorkflowRunStep } from "@/api/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { JsonTree } from "@/components/workflows/json-tree";
import { WorkflowGraph } from "@/components/workflows/workflow-graph";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

export default function WorkflowRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: run, isLoading } = useWorkflowRun(id!);
  const { data: workflow } = useWorkflow(run?.workflowId ?? "");
  const retryRun = useRetryWorkflowRun();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(new Set());
  const stepRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const duration =
    run?.startedAt && run?.finishedAt ? formatElapsed(run.startedAt, run.finishedAt) : null;

  const toggleStep = useCallback((nodeId: string) => {
    setExpandedStepIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  // When a graph node is clicked, expand and scroll to that step
  const handleGraphNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setExpandedStepIds((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
    // Scroll to the step card after a tick (to allow expansion to render)
    requestAnimationFrame(() => {
      const el = stepRefs.current.get(nodeId);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, []);

  // When a step card is clicked, highlight the node in the graph (don't toggle expand)
  const handleStepClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  // Clear selection when clicking graph background (deselect)
  useEffect(() => {
    // If selectedNodeId doesn't match any step, clear it
    if (selectedNodeId && run?.steps && !run.steps.find((s) => s.nodeId === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, run?.steps]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (!run) {
    return <p className="text-muted-foreground">Workflow run not found.</p>;
  }

  const steps = run.steps ?? [];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Header */}
      <div className="shrink-0 space-y-3">
        <button
          type="button"
          onClick={() => navigate("/workflows?tab=runs")}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Runs
        </button>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">Run of {workflow?.name ?? "..."}</h1>
          <StatusBadge status={run.status} size="md" />
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {formatSmartTime(run.startedAt)}
          </Badge>
          {duration && (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase font-mono"
            >
              {duration}
            </Badge>
          )}
          {run.status === "failed" && (
            <div className="ml-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={() => retryRun.mutate(run.id)}
                disabled={retryRun.isPending}
              >
                <RefreshCw className="h-3 w-3 mr-1" /> Retry
              </Button>
            </div>
          )}
        </div>

        {run.error && (
          <Alert variant="destructive">
            <AlertDescription className="text-xs font-mono whitespace-pre-wrap">
              {run.error}
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Split layout: graph + steps panel */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 gap-4">
        {/* Graph panel */}
        <div className="flex-[3] min-h-[300px] md:min-h-0">
          {workflow && (
            <WorkflowGraph
              definition={workflow.definition}
              steps={run.steps}
              onNodeClick={handleGraphNodeClick}
              selectedNodeId={selectedNodeId}
              className="h-full min-h-[300px]"
            />
          )}
        </div>

        {/* Steps panel */}
        <div className="flex-[2] min-h-0 flex flex-col rounded-lg border bg-card">
          <div className="shrink-0 px-4 py-3 border-b flex items-center justify-between">
            <h2 className="text-sm font-semibold">Steps ({steps.length})</h2>
            {steps.length > 0 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs text-muted-foreground"
                  onClick={() => setExpandedStepIds(new Set(steps.map((s) => s.nodeId)))}
                  title="Expand all"
                >
                  <ChevronsUpDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs text-muted-foreground"
                  onClick={() => setExpandedStepIds(new Set())}
                  title="Collapse all"
                >
                  <ChevronsDownUp className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-2 space-y-1.5">
              {steps.map((step) => (
                <StepCard
                  key={step.id}
                  step={step}
                  workflowNodes={workflow?.definition.nodes}
                  isSelected={selectedNodeId === step.nodeId}
                  isExpanded={expandedStepIds.has(step.nodeId)}
                  onClick={() => handleStepClick(step.nodeId)}
                  onToggleExpand={() => toggleStep(step.nodeId)}
                  ref={(el) => {
                    if (el) {
                      stepRefs.current.set(step.nodeId, el);
                    } else {
                      stepRefs.current.delete(step.nodeId);
                    }
                  }}
                />
              ))}
              {steps.length === 0 && (
                <p className="text-sm text-muted-foreground p-4 text-center">
                  No steps executed yet.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

// --- Step Card ---

import { forwardRef } from "react";
import type { WorkflowNode } from "@/api/types";

interface StepCardProps {
  step: WorkflowRunStep;
  workflowNodes?: WorkflowNode[];
  isSelected: boolean;
  isExpanded: boolean;
  onClick: () => void;
  onToggleExpand: () => void;
}

const StepCard = forwardRef<HTMLDivElement, StepCardProps>(
  ({ step, workflowNodes, isSelected, isExpanded, onClick, onToggleExpand }, ref) => {
    const node = workflowNodes?.find((n) => n.id === step.nodeId);
    const label = node?.label || step.nodeId;
    const duration =
      step.startedAt && step.finishedAt ? formatElapsed(step.startedAt, step.finishedAt) : null;

    return (
      <div
        ref={ref}
        onClick={onClick}
        className={cn(
          "rounded-md border bg-background transition-colors cursor-pointer",
          isSelected && "border-l-2 border-l-amber-500",
        )}
      >
        {/* Header row - always visible */}
        <div className="w-full flex items-center gap-2 px-3 py-2">
          <span className="text-sm font-medium truncate">{label}</span>

          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase shrink-0"
          >
            {step.nodeType}
          </Badge>

          <StatusBadge status={step.status} className="shrink-0" />

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {duration && (
              <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                <Timer className="h-3 w-3" />
                {duration}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-1 space-y-3 border-t">
            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <MetaField label="Started" value={formatSmartTime(step.startedAt)} />
              {step.finishedAt && (
                <MetaField label="Finished" value={formatSmartTime(step.finishedAt)} />
              )}
              {duration && <MetaField label="Duration" value={duration} mono />}
            </div>

            {/* Retry info */}
            {step.retryCount != null && step.retryCount > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <Badge
                  variant="outline"
                  className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase text-amber-600 dark:text-amber-400"
                >
                  Retry {step.retryCount}
                  {step.maxRetries != null ? `/${step.maxRetries}` : ""}
                </Badge>
                {step.nextRetryAt && (
                  <span className="text-muted-foreground">
                    next: {formatSmartTime(step.nextRetryAt)}
                  </span>
                )}
              </div>
            )}

            {/* Error */}
            {step.error && (
              <Alert variant="destructive" className="py-2">
                <AlertCircle className="h-3.5 w-3.5" />
                <AlertDescription className="text-xs font-mono whitespace-pre-wrap">
                  {step.error}
                </AlertDescription>
              </Alert>
            )}

            {/* Input */}
            {step.input != null && (
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Input</span>
                <JsonTree data={step.input} defaultExpandDepth={1} maxHeight="200px" />
              </div>
            )}

            {/* Output */}
            {step.output != null && (
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  Output
                </span>
                <JsonTree data={step.output} defaultExpandDepth={1} maxHeight="200px" />
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
);
StepCard.displayName = "StepCard";

// --- Small helpers ---

function MetaField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <p className={cn("text-xs", mono && "font-mono")}>{value}</p>
    </div>
  );
}
