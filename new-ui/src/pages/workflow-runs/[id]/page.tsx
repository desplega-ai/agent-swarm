import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useRetryWorkflowRun, useWorkflow, useWorkflowRun } from "@/api/hooks/use-workflows";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { JsonTree } from "@/components/workflows/json-tree";
import { StepCard } from "@/components/workflows/step-card";
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
  const [triggerExpanded, setTriggerExpanded] = useState(false);
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

  const steps = run?.steps ?? [];

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of steps) {
      counts[s.status] = (counts[s.status] || 0) + 1;
    }
    return counts;
  }, [steps]);

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

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Header */}
      <div className="shrink-0 space-y-3">
        <button
          type="button"
          onClick={() => navigate(`/workflows/${run.workflowId}?tab=runs`)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Runs
        </button>

        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">
            Run of{" "}
            <Link to={`/workflows/${run.workflowId}`} className="text-primary hover:underline">
              {workflow?.name ?? "..."}
            </Link>
          </h1>
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
            <AlertDescription className="text-xs font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto">
              {run.error}
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Trigger Data (collapsible) */}
      {run.triggerData != null && (
        <div className="shrink-0 rounded-md border border-border/50">
          <button
            type="button"
            onClick={() => setTriggerExpanded(!triggerExpanded)}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-left"
          >
            {triggerExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="text-xs text-muted-foreground">Trigger Data</span>
          </button>
          {triggerExpanded && (
            <div className="px-3 pb-2.5">
              <JsonTree data={run.triggerData} defaultExpandDepth={1} maxHeight="200px" />
            </div>
          )}
        </div>
      )}

      {/* Step Summary Bar */}
      {steps.length > 0 && (
        <div className="shrink-0 flex items-center gap-3 text-xs text-muted-foreground">
          {Object.entries(statusCounts).map(([status, count]) => (
            <span key={status} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-block h-2 w-2 rounded-full",
                  status === "completed" && "bg-emerald-500",
                  status === "running" && "bg-amber-500",
                  status === "waiting" && "bg-yellow-500",
                  status === "failed" && "bg-red-500",
                  status === "pending" && "bg-zinc-500",
                  status === "skipped" && "bg-zinc-400/40",
                )}
              />
              {count} {status}
            </span>
          ))}
          <span className="text-muted-foreground/60">·</span>
          <span>
            {steps.length} step{steps.length !== 1 ? "s" : ""} total
          </span>
        </div>
      )}

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
