/**
 * Phone layout (below `md`) of the workflow run page.
 *
 * The desktop page is a viewport-sized split: header, trigger data, counts, then a graph beside a
 * scrolling Steps panel. On a phone that stacks into a ~250px graph with 5px node text, a Steps
 * panel that starts at 70% of the screen and clips its status badge, and a nested scroll box.
 *
 * This view leads with what the run needs from you (the first failed step and its error, or the
 * step it is waiting on), then offers three tabs: Steps (full-width rows, expand inline, status
 * chips that filter), Graph (fills the viewport when opened, tap a node to jump to its step) and
 * Trigger. Everything flows in the page scroller: no nested scroll box.
 */
import { ArrowLeft, ChevronDown, ChevronRight, ChevronsDownUp, RefreshCw, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Workflow, WorkflowNode, WorkflowRunStep, WorkflowRunWithSteps } from "@/api/types";
import { JsonTree } from "@/components/shared/json-tree";
import { StatusBadge } from "@/components/shared/status-badge";
import { ProgressRing, TaskStatusIcon } from "@/components/shared/task-status-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  foreachChildSummary,
  foreachFailurePolicy,
  groupForeachAttempts,
} from "@/components/workflows/foreach-step-group";
import { effectiveChildStatus } from "@/components/workflows/graph-utils";
import { StepCard } from "@/components/workflows/step-card";
import { WorkflowGraph } from "@/components/workflows/workflow-graph";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { STATUS_LABELS } from "@/lib/status-labels";
import { parseSyntheticStepId } from "@/lib/synthetic-step-id";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

/** A row in the Steps list: a plain step, or a `foreach` parent with its fanned-out children. */
export type StepListEntry =
  | { kind: "step"; step: WorkflowRunStep }
  | { kind: "foreach"; parent: WorkflowRunStep; children: WorkflowRunStep[] };

type RunView = "steps" | "graph" | "trigger";

/** Failed first, then what is still moving, then the quiet statuses. */
const STATUS_ORDER = [
  "failed",
  "waiting",
  "running",
  "pending",
  "cancelled",
  "completed",
  "skipped",
];

/** A foreach fan-out can be hundreds of items; show a page of them, then an escape hatch. */
const CHILD_PAGE_SIZE = 25;

export interface MobileRunViewProps {
  run: WorkflowRunWithSteps;
  workflow: Workflow | undefined;
  steps: WorkflowRunStep[];
  stepEntries: StepListEntry[];
  foreachIds: ReadonlySet<string>;
  selectedNodeId: string | null;
  expandedStepIds: ReadonlySet<string>;
  openGroups: Record<string, boolean>;
  statusCounts: Record<string, number>;
  duration: string | null;
  retryPending: boolean;
  parentLink: ReactNode;
  stepRefs: { current: Map<string, HTMLDivElement> };
  registerStepRef: (nodeId: string, el: HTMLDivElement | null) => void;
  onBack: () => void;
  onRetry: () => void;
  /** Select + expand a step (graph node tap or "View step"), opening its foreach group. */
  onJumpToNode: (nodeId: string) => void;
  onToggleStep: (nodeId: string) => void;
  onToggleGroup: (parentNodeId: string) => void;
  onCollapseAll: () => void;
}

export function MobileRunView(props: MobileRunViewProps) {
  const {
    run,
    workflow,
    steps,
    stepEntries,
    foreachIds,
    expandedStepIds,
    statusCounts,
    duration,
    retryPending,
    parentLink,
    stepRefs,
    onBack,
    onRetry,
    onJumpToNode,
    onCollapseAll,
  } = props;
  const { searchParams, setParam } = useUrlSearchState();
  const viewParam = readStringParam(searchParams, "view", "steps");
  const hasTrigger = run.triggerData != null;
  const view: RunView =
    viewParam === "graph" && workflow
      ? "graph"
      : viewParam === "trigger" && hasTrigger
        ? "trigger"
        : "steps";
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  const setView = (next: string) => setParam("view", next, { defaultValue: "steps" });

  // Jump from the graph or the callout: expand the step, show the Steps tab, scroll to the row.
  const jumpToStep = (nodeId: string) => {
    onJumpToNode(nodeId);
    setStatusFilter(null);
    setScrollTarget(nodeId);
    if (view !== "steps") setView("steps");
  };

  // Scroll once the target row is open: its expansion grows the page, and a smooth scroll
  // started earlier would stop at the old, shorter page height.
  useEffect(() => {
    if (!scrollTarget || view !== "steps") return;
    if (scrollTarget !== "__tabs" && !expandedStepIds.has(scrollTarget)) {
      const giveUp = setTimeout(() => setScrollTarget(null), 1500);
      return () => clearTimeout(giveUp);
    }
    const frame = requestAnimationFrame(() => {
      const target =
        scrollTarget === "__tabs" ? tabsRef.current : stepRefs.current.get(scrollTarget);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      setScrollTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollTarget, view, expandedStepIds, stepRefs]);

  // Opening the graph brings its tab bar to the top so the graph fills the rest of the screen.
  useEffect(() => {
    if (view === "graph") tabsRef.current?.scrollIntoView({ block: "start" });
  }, [view]);

  const nodes = workflow?.definition.nodes;
  const filteredSteps = statusFilter ? steps.filter((s) => s.status === statusFilter) : null;
  const chips = STATUS_ORDER.filter((status) => statusCounts[status]).concat(
    Object.keys(statusCounts).filter((status) => !STATUS_ORDER.includes(status)),
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Header: one action row, the title, then the facts as one wrapping badge row. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Runs
          </button>
          {run.status === "failed" && (
            <Button variant="outline" className="h-9" onClick={onRetry} disabled={retryPending}>
              <RefreshCw className={cn("size-3.5", retryPending && "animate-spin")} /> Retry run
            </Button>
          )}
        </div>
        <h1 className="text-lg font-semibold leading-tight [overflow-wrap:anywhere]">
          Run of{" "}
          <Link to={`/workflows/${run.workflowId}`} className="text-primary hover:underline">
            {workflow?.name ?? "..."}
          </Link>
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={run.status} size="md" />
          {run.parent && (
            <Badge
              variant="outline"
              size="tag"
              className="border-action-sub-workflow/40 text-action-sub-workflow"
            >
              child run
            </Badge>
          )}
          <Badge variant="outline" size="tag">
            {formatSmartTime(run.startedAt)}
          </Badge>
          {duration && (
            <Badge variant="outline" size="tag" className="font-mono">
              {duration}
            </Badge>
          )}
        </div>
        {parentLink}
      </div>

      <RunAttention
        run={run}
        steps={steps}
        nodes={nodes}
        foreachIds={foreachIds}
        onView={jumpToStep}
        onShowFailed={() => {
          setStatusFilter("failed");
          setScrollTarget("__tabs");
          if (view !== "steps") setView("steps");
        }}
      />

      <Tabs value={view} onValueChange={setView} className="gap-2" ref={tabsRef}>
        <div className="sticky top-0 z-10 -mx-4 bg-background px-4 pb-1 pt-1">
          <TabsList className="w-full">
            <TabsTrigger value="steps">
              Steps
              <span className="font-mono text-xs text-muted-foreground">{steps.length}</span>
            </TabsTrigger>
            <TabsTrigger value="graph" disabled={!workflow}>
              Graph
            </TabsTrigger>
            {hasTrigger && <TabsTrigger value="trigger">Trigger</TabsTrigger>}
          </TabsList>
        </div>

        <TabsContent value="steps" className="flex flex-col gap-2">
          {steps.length > 0 && (
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {chips.map((status) => {
                  const active = statusFilter === status;
                  return (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setStatusFilter(active ? null : status)}
                      className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs text-muted-foreground transition-colors",
                        active
                          ? "border-primary/60 bg-primary/10 text-foreground"
                          : "hover:text-foreground",
                      )}
                    >
                      <TaskStatusIcon status={status} className="size-3.5" />
                      {statusCounts[status]} {(STATUS_LABELS[status] ?? status).toLowerCase()}
                      {active && <X className="size-3" aria-label="Clear filter" />}
                    </button>
                  );
                })}
              </div>
              {expandedStepIds.size > 0 && (
                <Button
                  variant="ghost"
                  className="h-8 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
                  onClick={onCollapseAll}
                >
                  <ChevronsDownUp className="size-3.5" /> Collapse
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {filteredSteps
              ? filteredSteps.map((step) => (
                  <MobileStepRow
                    key={step.id}
                    step={step}
                    nodes={nodes}
                    foreachIds={foreachIds}
                    isSelected={props.selectedNodeId === step.nodeId}
                    isExpanded={expandedStepIds.has(step.nodeId)}
                    onToggle={() => props.onToggleStep(step.nodeId)}
                    rowRef={(el) => props.registerStepRef(step.nodeId, el)}
                    showItemKey
                  />
                ))
              : stepEntries.map((entry) =>
                  entry.kind === "foreach" && entry.children.length > 0 ? (
                    <MobileForeachGroup
                      key={entry.parent.id}
                      parent={entry.parent}
                      childSteps={entry.children}
                      nodes={nodes}
                      onNodeFailure={workflow?.definition.onNodeFailure}
                      foreachIds={foreachIds}
                      selectedNodeId={props.selectedNodeId}
                      expandedStepIds={expandedStepIds}
                      isOpen={props.openGroups[entry.parent.nodeId] ?? false}
                      onToggleOpen={() => props.onToggleGroup(entry.parent.nodeId)}
                      onToggleStep={props.onToggleStep}
                      registerStepRef={props.registerStepRef}
                    />
                  ) : (
                    <MobileStepRow
                      key={entry.kind === "foreach" ? entry.parent.id : entry.step.id}
                      step={entry.kind === "foreach" ? entry.parent : entry.step}
                      nodes={nodes}
                      foreachIds={foreachIds}
                      isSelected={
                        props.selectedNodeId ===
                        (entry.kind === "foreach" ? entry.parent.nodeId : entry.step.nodeId)
                      }
                      isExpanded={expandedStepIds.has(
                        entry.kind === "foreach" ? entry.parent.nodeId : entry.step.nodeId,
                      )}
                      onToggle={() =>
                        props.onToggleStep(
                          entry.kind === "foreach" ? entry.parent.nodeId : entry.step.nodeId,
                        )
                      }
                      rowRef={(el) =>
                        props.registerStepRef(
                          entry.kind === "foreach" ? entry.parent.nodeId : entry.step.nodeId,
                          el,
                        )
                      }
                    />
                  ),
                )}
            {steps.length === 0 && (
              <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                No steps executed yet.
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="graph">
          {workflow && (
            <div className="relative">
              <p className="pointer-events-none absolute left-3 top-2 z-10 text-[11px] text-muted-foreground">
                Pinch to zoom, tap a node to jump to its step
              </p>
              {/* Tall enough that, with the tab bar scrolled to the top, it fills the screen. */}
              <WorkflowGraph
                definition={workflow.definition}
                steps={run.steps}
                onNodeClick={jumpToStep}
                selectedNodeId={props.selectedNodeId}
                className="h-[calc(100dvh-7.5rem)] min-h-[360px]"
              />
            </div>
          )}
        </TabsContent>

        {hasTrigger && (
          <TabsContent value="trigger">
            <JsonTree data={run.triggerData} defaultExpandDepth={1} maxHeight="none" />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

/** Label of a step: the workflow node's label (the parent node for a foreach item), plus the item. */
function stepLabel(
  step: WorkflowRunStep,
  nodes: WorkflowNode[] | undefined,
  foreachIds: ReadonlySet<string>,
) {
  const { parentNodeId, itemKey } = parseSyntheticStepId(step.nodeId, foreachIds);
  const node = nodes?.find((n) => n.id === parentNodeId);
  return { node, label: node?.label || parentNodeId, itemKey };
}

/**
 * What the run needs from the viewer, above the tabs. Failed run: the first failed step and the
 * error. Run in flight: the step it is working on or waiting for.
 */
function RunAttention({
  run,
  steps,
  nodes,
  foreachIds,
  onView,
  onShowFailed,
}: {
  run: WorkflowRunWithSteps;
  steps: WorkflowRunStep[];
  nodes: WorkflowNode[] | undefined;
  foreachIds: ReadonlySet<string>;
  onView: (nodeId: string) => void;
  onShowFailed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = steps.filter((s) => s.status === "failed");
  const first = failed[0];

  if (first || run.status === "failed" || run.error) {
    const message = run.error ?? first?.error;
    const long = !!message && (message.length > 130 || message.includes("\n"));
    const named = first ? stepLabel(first, nodes, foreachIds) : null;
    return (
      <section
        aria-label="Failure"
        className="space-y-2 rounded-lg border border-status-error/40 bg-status-error/5 p-3"
      >
        <div className="flex items-start gap-2">
          <TaskStatusIcon status="failed" className="mt-0.5 size-4" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium [overflow-wrap:anywhere]">
              {named ? (
                <>
                  Failed at <span className="font-semibold">{named.label}</span>
                  {named.itemKey ? <span className="font-mono"> · {named.itemKey}</span> : null}
                </>
              ) : (
                "Run failed"
              )}
            </p>
          </div>
        </div>
        {message && (
          <p
            className={cn(
              "whitespace-pre-wrap font-mono text-xs text-status-error-strong [overflow-wrap:anywhere]",
              !open && "line-clamp-3",
            )}
          >
            {message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {first && (
            <Button variant="outline" className="h-9" onClick={() => onView(first.nodeId)}>
              View step
            </Button>
          )}
          {failed.length > 1 && (
            <Button
              variant="ghost"
              className="h-9 text-xs text-muted-foreground"
              onClick={onShowFailed}
            >
              All {failed.length} failed
            </Button>
          )}
          {long && (
            <Button
              variant="ghost"
              className="h-9 text-xs text-muted-foreground"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Show less" : "Show full error"}
            </Button>
          )}
        </div>
      </section>
    );
  }

  const active =
    steps.find((s) => s.status === "waiting") ?? steps.find((s) => s.status === "running");
  if (!active) return null;
  const named = stepLabel(active, nodes, foreachIds);
  return (
    <section
      aria-label="Current step"
      className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
    >
      <TaskStatusIcon status={active.status} className="size-4" />
      <p className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
        <span className="text-muted-foreground">
          {active.status === "waiting" ? "Waiting on" : "Running"}{" "}
        </span>
        <span className="font-medium">{named.label}</span>
      </p>
      <Button variant="outline" className="h-9 shrink-0" onClick={() => onView(active.nodeId)}>
        View step
      </Button>
    </section>
  );
}

/**
 * One step: title and status on the first line, node type and duration under it, the whole row
 * tappable. The expanded detail is the shared `StepCard` body (its header row hidden), so every
 * node type keeps its output rendering, and its own scroll boxes are opened up.
 */
function MobileStepRow({
  step,
  nodes,
  foreachIds,
  isSelected,
  isExpanded,
  onToggle,
  rowRef,
  inGroup = false,
  showItemKey = false,
  earlierAttempts = [],
}: {
  step: WorkflowRunStep;
  nodes: WorkflowNode[] | undefined;
  foreachIds: ReadonlySet<string>;
  isSelected: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
  inGroup?: boolean;
  showItemKey?: boolean;
  earlierAttempts?: WorkflowRunStep[];
}) {
  const { label, itemKey } = stepLabel(step, nodes, foreachIds);
  const displayStatus = itemKey ? effectiveChildStatus(step) : step.status;
  const duration =
    step.startedAt && step.finishedAt ? formatElapsed(step.startedAt, step.finishedAt) : null;
  const iteration =
    itemKey && typeof step.input === "object" && step.input !== null
      ? (step.input as Record<string, unknown>).index
      : undefined;
  const typeText = itemKey
    ? `${step.nodeType} · ${typeof iteration === "number" ? `#${iteration}` : "item"}`
    : step.nodeType;
  const itemOnly = inGroup && itemKey;

  return (
    <div
      ref={rowRef}
      className={cn(
        "scroll-mt-12 overflow-hidden rounded-lg border bg-card transition-colors",
        isSelected && "border-primary/70",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex min-h-11 w-full min-w-0 items-start gap-2 px-3 py-2.5 text-left outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-start gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]",
                itemOnly && "font-mono",
              )}
            >
              {itemOnly ? itemKey : label}
              {showItemKey && itemKey ? (
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {" "}
                  · {itemKey}
                </span>
              ) : null}
            </span>
            <StatusBadge status={displayStatus} size="md" className="shrink-0" />
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{typeText}</span>
            {step.nextPort && step.nextPort !== "default" && (
              <Badge
                variant="outline"
                size="tag"
                className="border-status-info/30 text-status-info-strong"
              >
                port: {step.nextPort}
              </Badge>
            )}
            {earlierAttempts.length > 0 && (
              <Badge
                variant="outline"
                size="tag"
                className="border-status-active/30 text-status-active-strong"
              >
                attempt {earlierAttempts.length + 1}
              </Badge>
            )}
            {duration && <span className="font-mono">{duration}</span>}
          </span>
        </span>
        {isExpanded ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>
      {isExpanded && (
        // StepCard's header row is hidden (the row above replaces it) and its own scroll boxes
        // (`pre` outputs, JsonTree's inline max-height) are opened up: the page scrolls instead.
        <div className="[&>div]:rounded-none [&>div]:border-0 [&_[style*='max-height']]:max-h-none! [&_pre]:max-h-none! [&>div>div:first-child]:hidden">
          <StepCard
            step={step}
            workflowNodes={nodes}
            isSelected={false}
            isExpanded
            onClick={() => {}}
            onToggleExpand={onToggle}
            inGroup={inGroup}
            earlierAttempts={earlierAttempts}
          />
        </div>
      )}
    </div>
  );
}

/** A `foreach` parent row, a summary toggle for its items, and the items as indented rows. */
function MobileForeachGroup({
  parent,
  childSteps,
  nodes,
  onNodeFailure,
  foreachIds,
  selectedNodeId,
  expandedStepIds,
  isOpen,
  onToggleOpen,
  onToggleStep,
  registerStepRef,
}: {
  parent: WorkflowRunStep;
  childSteps: WorkflowRunStep[];
  nodes: WorkflowNode[] | undefined;
  onNodeFailure: Workflow["definition"]["onNodeFailure"];
  foreachIds: ReadonlySet<string>;
  selectedNodeId: string | null;
  expandedStepIds: ReadonlySet<string>;
  isOpen: boolean;
  onToggleOpen: () => void;
  onToggleStep: (nodeId: string) => void;
  registerStepRef: (nodeId: string, el: HTMLDivElement | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const items = groupForeachAttempts(childSteps);
  const summary = foreachChildSummary(childSteps);
  const policy = foreachFailurePolicy(
    nodes?.find((n) => n.id === parent.nodeId),
    onNodeFailure,
  );
  const visible = showAll ? items : items.slice(0, CHILD_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-2">
      <MobileStepRow
        step={parent}
        nodes={nodes}
        foreachIds={foreachIds}
        isSelected={selectedNodeId === parent.nodeId}
        isExpanded={expandedStepIds.has(parent.nodeId)}
        onToggle={() => onToggleStep(parent.nodeId)}
        rowRef={(el) => registerStepRef(parent.nodeId, el)}
      />
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className="flex min-h-9 flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {isOpen ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
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
        <Badge variant="outline" size="tag">
          {policy}
        </Badge>
      </button>
      {isOpen && (
        <div className="ml-2 flex flex-col gap-2 border-l border-border/60 pl-3">
          {visible.map(({ latest, earlier }) => (
            <MobileStepRow
              key={latest.id}
              step={latest}
              nodes={nodes}
              foreachIds={foreachIds}
              isSelected={selectedNodeId === latest.nodeId || selectedNodeId === parent.nodeId}
              isExpanded={expandedStepIds.has(latest.nodeId)}
              onToggle={() => onToggleStep(latest.nodeId)}
              rowRef={(el) => registerStepRef(latest.nodeId, el)}
              earlierAttempts={earlier}
              inGroup
            />
          ))}
          {items.length > visible.length && (
            <Button
              variant="ghost"
              className="h-9 justify-start text-xs text-muted-foreground"
              onClick={() => setShowAll(true)}
            >
              Show all {items.length} items
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
