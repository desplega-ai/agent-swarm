import { ArrowLeft, ChevronsDownUp, ChevronsUpDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useRetryWorkflowRun, useWorkflow, useWorkflowRun } from "@/api/hooks/use-workflows";
import type { WorkflowRunStep } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ForeachStepGroup, foreachDefaultOpen } from "@/components/workflows/foreach-step-group";
import { JsonTree } from "@/components/workflows/json-tree";
import { StepCard } from "@/components/workflows/step-card";
import { WorkflowGraph } from "@/components/workflows/workflow-graph";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { foreachParentIds, parseSyntheticStepId } from "@/lib/synthetic-step-id";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

/** A row in the Steps panel: a plain step, or a `foreach` parent with its fanned-out children. */
type StepListEntry =
  | { kind: "step"; step: WorkflowRunStep }
  | { kind: "foreach"; parent: WorkflowRunStep; children: WorkflowRunStep[] };

export default function WorkflowRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: run, isLoading } = useWorkflowRun(id!);
  const { data: workflow } = useWorkflow(run?.workflowId ?? "");
  const retryRun = useRetryWorkflowRun();

  const { searchParams, setParam, setParams } = useUrlSearchState();
  const selectedNodeId = readStringParam(searchParams, "node") || null;
  const expandedStepsParam = readStringParam(searchParams, "steps");
  const expandedStepIds = useMemo(
    () => new Set(expandedStepsParam.split(",").filter(Boolean)),
    [expandedStepsParam],
  );
  const stepRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const steps = useMemo(() => run?.steps ?? [], [run?.steps]);
  const foreachIds = useMemo(
    () => foreachParentIds(workflow?.definition.nodes),
    [workflow?.definition.nodes],
  );

  // Synthetic `foreach` children (`<parentNodeId>#<itemKey>`) collapse under their parent step so a
  // wide fan-out doesn't flood the panel. Order is preserved; an orphan child still renders flat.
  const stepEntries = useMemo(() => {
    const entries: StepListEntry[] = [];
    const groups = new Map<
      string,
      { kind: "foreach"; parent: WorkflowRunStep; children: WorkflowRunStep[] }
    >();
    for (const step of steps) {
      const { parentNodeId, itemKey } = parseSyntheticStepId(step.nodeId, foreachIds);
      if (itemKey === null) {
        if (foreachIds.has(step.nodeId)) {
          const group = { kind: "foreach" as const, parent: step, children: [] };
          groups.set(step.nodeId, group);
          entries.push(group);
        } else {
          entries.push({ kind: "step", step });
        }
        continue;
      }
      const group = groups.get(parentNodeId);
      if (group) {
        group.children.push(step);
      } else {
        entries.push({ kind: "step", step });
      }
    }
    return entries;
  }, [steps, foreachIds]);

  // Children-list open state is UI-only (not in the URL). Each group is seeded once with its
  // default — open when anything failed or is still in flight — and user toggles then win.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const setGroupOpen = useCallback((nodeId: string, open: boolean) => {
    setOpenGroups((prev) => ({ ...prev, [nodeId]: open }));
  }, []);

  // Seed each group once (polling must not re-close a group the user opened), and drop the previous
  // run's toggles when navigating between runs without unmounting.
  const seededRunId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const isNewRun = seededRunId.current !== id;
    seededRunId.current = id;
    setOpenGroups((prev) => {
      const base = isNewRun ? {} : prev;
      let next = base;
      for (const entry of stepEntries) {
        if (entry.kind !== "foreach" || entry.parent.nodeId in base) continue;
        if (next === base) next = { ...base };
        next[entry.parent.nodeId] = foreachDefaultOpen(entry.children);
      }
      return next;
    });
  }, [stepEntries, id]);

  const setAllGroupsOpen = useCallback(
    (open: boolean) => {
      setOpenGroups(
        Object.fromEntries(
          stepEntries
            .filter((entry) => entry.kind === "foreach")
            .map((entry) => [entry.parent.nodeId, open]),
        ),
      );
    },
    [stepEntries],
  );

  const registerStepRef = useCallback((nodeId: string, el: HTMLDivElement | null) => {
    if (el) {
      stepRefs.current.set(nodeId, el);
    } else {
      stepRefs.current.delete(nodeId);
    }
  }, []);

  const setSelectedNodeId = useCallback(
    (nodeId: string | null) => setParam("node", nodeId),
    [setParam],
  );

  const setExpandedSteps = useCallback(
    (nodeIds: Iterable<string>) => {
      const value = Array.from(new Set(nodeIds)).filter(Boolean).join(",");
      setParam("steps", value);
    },
    [setParam],
  );

  const duration =
    run?.startedAt && run?.finishedAt ? formatElapsed(run.startedAt, run.finishedAt) : null;

  const toggleStep = useCallback(
    (nodeId: string) => {
      const next = new Set(expandedStepIds);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      setExpandedSteps(next);
    },
    [expandedStepIds, setExpandedSteps],
  );

  // When a graph node is clicked, expand and scroll to that step. A `foreach` node owns several
  // synthetic child steps (`<nodeId>#<itemKey>`) — expand all of them and scroll to the first.
  // Clicking the already-selected node deselects it. NOTE: `node` and `steps` must go through ONE
  // setParams call — two setSearchParams calls in the same tick both start from the same stale
  // params, so the second silently drops the first's update.
  const handleGraphNodeClick = useCallback(
    (nodeId: string) => {
      if (selectedNodeId === nodeId) {
        setSelectedNodeId(null);
        return;
      }
      if (foreachIds.has(nodeId)) setGroupOpen(nodeId, true);
      const ownStepIds = steps
        .map((step) => step.nodeId)
        .filter(
          (stepNodeId) => parseSyntheticStepId(stepNodeId, foreachIds).parentNodeId === nodeId,
        );
      const next = new Set(expandedStepIds);
      for (const stepNodeId of ownStepIds.length > 0 ? ownStepIds : [nodeId]) {
        next.add(stepNodeId);
      }
      setParams({
        node: nodeId,
        steps: Array.from(next).filter(Boolean).join(","),
      });
      // Scroll to the step card after a tick (to allow expansion to render)
      requestAnimationFrame(() => {
        const el = stepRefs.current.get(ownStepIds[0] ?? nodeId);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    },
    [
      expandedStepIds,
      selectedNodeId,
      setParams,
      setSelectedNodeId,
      setGroupOpen,
      steps,
      foreachIds,
    ],
  );

  // When a step card is clicked, highlight the node in the graph (don't toggle expand);
  // clicking the selected card again clears the selection.
  const handleStepClick = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(selectedNodeId === nodeId ? null : nodeId);
    },
    [selectedNodeId, setSelectedNodeId],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of steps) {
      counts[s.status] = (counts[s.status] || 0) + 1;
    }
    return counts;
  }, [steps]);

  // Clear selection when clicking graph background (deselect)
  useEffect(() => {
    // If selectedNodeId doesn't match any step, clear it. A `foreach` parent node id is matched by
    // its synthetic child steps even though no step carries that exact id.
    if (
      selectedNodeId &&
      run?.steps &&
      !run.steps.some(
        (s) =>
          s.nodeId === selectedNodeId ||
          parseSyntheticStepId(s.nodeId, foreachIds).parentNodeId === selectedNodeId,
      )
    ) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, run?.steps, setSelectedNodeId, foreachIds]);

  useEffect(() => {
    if (!run?.steps || expandedStepIds.size === 0) return;
    const validStepIds = new Set(run.steps.map((step) => step.nodeId));
    const validExpandedStepIds = Array.from(expandedStepIds).filter((nodeId) =>
      validStepIds.has(nodeId),
    );
    if (validExpandedStepIds.length !== expandedStepIds.size) {
      setExpandedSteps(validExpandedStepIds);
    }
  }, [expandedStepIds, run?.steps, setExpandedSteps]);

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

  const renderStepCard = (step: WorkflowRunStep) => (
    <StepCard
      key={step.id}
      step={step}
      workflowNodes={workflow?.definition.nodes}
      isSelected={
        selectedNodeId === step.nodeId ||
        selectedNodeId === parseSyntheticStepId(step.nodeId, foreachIds).parentNodeId
      }
      isExpanded={expandedStepIds.has(step.nodeId)}
      onClick={() => handleStepClick(step.nodeId)}
      onToggleExpand={() => toggleStep(step.nodeId)}
      ref={(el) => registerStepRef(step.nodeId, el)}
    />
  );

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

        <PageHeader
          title={
            <div className="flex items-center gap-3 flex-wrap min-w-0">
              <h1 className="text-xl font-semibold">
                Run of{" "}
                <Link to={`/workflows/${run.workflowId}`} className="text-primary hover:underline">
                  {workflow?.name ?? "..."}
                </Link>
              </h1>
              <StatusBadge status={run.status} size="md" />
              <Badge variant="outline" size="tag">
                {formatSmartTime(run.startedAt)}
              </Badge>
              {duration && (
                <Badge variant="outline" size="tag" className="font-mono">
                  {duration}
                </Badge>
              )}
            </div>
          }
          action={
            run.status === "failed" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => retryRun.mutate(run.id)}
                disabled={retryRun.isPending}
              >
                <RefreshCw className="h-3 w-3 mr-1" /> Retry
              </Button>
            )
          }
        />

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
        <CollapsibleSection
          title="Trigger Data"
          variant="card"
          borderColor="border-border/50"
          className="shrink-0"
        >
          <JsonTree data={run.triggerData} defaultExpandDepth={1} maxHeight="200px" />
        </CollapsibleSection>
      )}

      {/* Step Summary Bar */}
      {steps.length > 0 && (
        <div className="shrink-0 flex items-center gap-3 text-xs text-muted-foreground">
          {Object.entries(statusCounts).map(([status, count]) => (
            <span key={status} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-block h-2 w-2 rounded-full",
                  status === "completed" && "bg-status-success",
                  status === "running" && "bg-status-active",
                  status === "waiting" && "bg-status-pending",
                  status === "failed" && "bg-status-error",
                  status === "pending" && "bg-status-neutral",
                  status === "skipped" && "bg-status-neutral/40",
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
                  onClick={() => {
                    setExpandedSteps(steps.map((s) => s.nodeId));
                    setAllGroupsOpen(true);
                  }}
                  title="Expand all"
                >
                  <ChevronsUpDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs text-muted-foreground"
                  onClick={() => {
                    setExpandedSteps([]);
                    setAllGroupsOpen(false);
                  }}
                  title="Collapse all"
                >
                  <ChevronsDownUp className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-2 space-y-1.5">
              {stepEntries.map((entry) =>
                entry.kind === "foreach" && entry.children.length > 0 ? (
                  <ForeachStepGroup
                    key={entry.parent.id}
                    parent={entry.parent}
                    childSteps={entry.children}
                    workflowNodes={workflow?.definition.nodes}
                    selectedNodeId={selectedNodeId}
                    isOpen={openGroups[entry.parent.nodeId] ?? false}
                    onToggleOpen={() =>
                      setGroupOpen(entry.parent.nodeId, !openGroups[entry.parent.nodeId])
                    }
                    expandedStepIds={expandedStepIds}
                    onStepClick={handleStepClick}
                    onToggleStepExpand={toggleStep}
                    registerStepRef={registerStepRef}
                  />
                ) : (
                  renderStepCard(entry.kind === "foreach" ? entry.parent : entry.step)
                ),
              )}
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
