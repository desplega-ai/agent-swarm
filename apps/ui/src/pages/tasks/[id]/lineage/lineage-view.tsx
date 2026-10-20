import { CalendarClock, ChevronDown, Link2, Workflow } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { AgentTask } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ModelLabel } from "@/components/shared/model-logo";
import { StatusBadge } from "@/components/shared/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCost } from "@/lib/cost-format";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatElapsed } from "@/lib/utils";
import { type LineageNode, ROW_LIMIT, visibleChildren } from "./lineage-tree";

/** Everything a branch needs to draw itself and its subtree. */
export interface LineageViewState {
  focusId: string;
  pathIds: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  /** Children shown per parent past the default, keyed by parent id. */
  shownCount: ReadonlyMap<string, number>;
  toggle: (id: string) => void;
  showMore: (id: string) => void;
  agentName: (agentId: string | null | undefined) => string | null;
}

const LINE = "border-muted-foreground/30";
const PATH_LINE = "border-primary";
/** Statuses drawn faded: the task stopped without finishing its work. */
const FADED = new Set(["cancelled", "superseded"]);

/** Cents are enough on a card: "$0.97", or "<$0.01" below a cent. */
export function cardCost(amount: number): string {
  return amount < 0.01 ? "<$0.01" : formatCost(amount, { precision: 2 });
}

/** Wall time a task ran: accept (or create) to finish, or to now while it runs. */
function runTime(task: AgentTask): string | null {
  if (task.status === "pending" || task.status === "offered" || task.status === "backlog") {
    return null;
  }
  return formatElapsed(task.acceptedAt ?? task.createdAt, task.finishedAt);
}

/**
 * The whole lineage, top-down: the root card, its children in a row joined by
 * an elbow bar, and each child's own subtree as an indented list under it.
 * A root with more than `ROW_LIMIT` children stacks them instead.
 */
export function LineageView({ root, state }: { root: LineageNode; state: LineageViewState }) {
  // A wide fan-out reads better as a list than as a row thousands of pixels long.
  if (root.children.length > ROW_LIMIT) {
    return (
      <div className="min-w-max px-6 pb-8">
        <Branch node={root} state={state} />
      </div>
    );
  }
  const open = state.expanded.has(root.task.id);
  const { shown, hidden } = visibleChildren(
    root,
    state.shownCount.get(root.task.id),
    state.pathIds,
  );
  return (
    <div className="flex min-w-max flex-col items-center px-4 pb-8">
      <LineageCard node={root} state={state} />
      {open && shown.length > 0 ? (
        <>
          <span aria-hidden className={cn("h-5 border-l", lineClass(root, shown, state))} />
          <ol className="flex items-start">
            {shown.map((child, index) => (
              <li key={child.task.id} className="relative flex flex-col items-center px-2 pt-5">
                <RowConnector
                  index={index}
                  count={shown.length + (hidden > 0 ? 1 : 0)}
                  onPath={state.pathIds.has(child.task.id)}
                />
                <Branch node={child} state={state} />
              </li>
            ))}
            {hidden > 0 ? (
              <li className="relative flex flex-col items-center px-2 pt-5">
                <RowConnector index={shown.length} count={shown.length + 1} onPath={false} />
                <MoreButton hidden={hidden} onClick={() => state.showMore(root.task.id)} />
              </li>
            ) : null}
          </ol>
        </>
      ) : null}
    </div>
  );
}

/** The stem under the root: on the path when the focused task sits below it. */
function lineClass(node: LineageNode, shown: LineageNode[], state: LineageViewState): string {
  return state.pathIds.has(node.task.id) && shown.some((child) => state.pathIds.has(child.task.id))
    ? PATH_LINE
    : LINE;
}

/** The bar over a row of children, with rounded ends and a drop into each card. */
function RowConnector({ index, count, onPath }: { index: number; count: number; onPath: boolean }) {
  const color = onPath ? PATH_LINE : LINE;
  if (count === 1) {
    return <span aria-hidden className={cn("absolute top-0 left-1/2 h-5 border-l", color)} />;
  }
  if (index === 0) {
    return (
      <span
        aria-hidden
        className={cn("absolute top-0 right-0 left-1/2 h-5 rounded-tl-lg border-t border-l", color)}
      />
    );
  }
  if (index === count - 1) {
    return (
      <span
        aria-hidden
        className={cn("absolute top-0 right-1/2 left-0 h-5 rounded-tr-lg border-t border-r", color)}
      />
    );
  }
  return (
    <>
      <span aria-hidden className={cn("absolute top-0 right-0 left-0 border-t", LINE)} />
      <span aria-hidden className={cn("absolute top-0 left-1/2 h-5 border-l", color)} />
    </>
  );
}

/** A card and, when open, its children as an indented list joined by a rail. */
function Branch({ node, state }: { node: LineageNode; state: LineageViewState }) {
  const open = state.expanded.has(node.task.id);
  const { shown, hidden } = visibleChildren(
    node,
    state.shownCount.get(node.task.id),
    state.pathIds,
  );
  return (
    <div className="flex flex-col items-start">
      <LineageCard node={node} state={state} />
      {open && shown.length > 0 ? (
        <ol className="ml-4">
          {shown.map((child, index) => (
            <RailItem
              key={child.task.id}
              last={index === shown.length - 1 && hidden === 0}
              onPath={state.pathIds.has(child.task.id)}
            >
              <Branch node={child} state={state} />
            </RailItem>
          ))}
          {hidden > 0 ? (
            <RailItem last onPath={false}>
              <MoreButton hidden={hidden} onClick={() => state.showMore(node.task.id)} />
            </RailItem>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}

/** One row under a rail: an elbow into the card, and the rail running on past it unless last. */
function RailItem({
  last,
  onPath,
  children,
}: {
  last: boolean;
  onPath: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative pt-3 pl-6">
      {last ? null : (
        <span aria-hidden className={cn("absolute top-0 bottom-0 left-0 border-l", LINE)} />
      )}
      <span
        aria-hidden
        className={cn(
          "absolute top-0 left-0 h-9 w-5 rounded-bl-lg border-b border-l",
          onPath ? PATH_LINE : LINE,
        )}
      />
      {children}
    </li>
  );
}

function MoreButton({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover-linger mt-1 flex h-12 w-72 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      Show more ({hidden} hidden)
    </button>
  );
}

/**
 * One task: who ran it on what model, its status, title, cost and run time.
 * The whole card links to the task; the child toggle and the link chips sit
 * above that link.
 */
function LineageCard({ node, state }: { node: LineageNode; state: LineageViewState }) {
  const { task } = node;
  const current = task.id === state.focusId;
  const ref = useRef<HTMLDivElement | null>(null);
  // Bring the focused task into view on first paint, scrolling as little as
  // possible so the root above it stays in view when it fits.
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  const assignee = task.agentId
    ? (state.agentName(task.agentId) ?? `${task.agentId.slice(0, 8)}…`)
    : "Unassigned";
  const creator =
    task.creatorAgentId && task.creatorAgentId !== task.agentId
      ? (state.agentName(task.creatorAgentId) ?? `${task.creatorAgentId.slice(0, 8)}…`)
      : null;
  const model = task.resolvedModel ?? task.model;
  const cost = task.totalCostUsd ? cardCost(task.totalCostUsd) : null;
  const time = runTime(task);
  const open = state.expanded.has(task.id);
  const childCount = node.children.length;

  return (
    <div
      ref={ref}
      data-current={current || undefined}
      className={cn(
        "relative w-72 rounded-xl border bg-card p-3 text-card-foreground shadow-xs transition-colors hover:border-foreground/25",
        current && "border-primary ring-2 ring-primary/40",
        FADED.has(task.status) && !current && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <AgentAvatar agentId={task.agentId} agentName={assignee} size="sm" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{assignee}</div>
          {model ? (
            <ModelLabel model={model} className="max-w-full text-xs text-muted-foreground" />
          ) : null}
        </div>
        <StatusBadge status={task.status} />
      </div>

      <Link
        to={`/tasks/${task.id}`}
        aria-current={current ? "page" : undefined}
        className="mt-2 line-clamp-2 text-sm text-pretty outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
      >
        {taskListTitle(task)}
      </Link>

      {creator ? (
        <p className="mt-1 truncate text-xs text-muted-foreground">Started by {creator}</p>
      ) : null}

      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">
          {[cost, time].filter(Boolean).join(" · ") || `#${task.id.slice(0, 8)}`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <TaskLinks task={task} />
          {childCount > 0 ? (
            <button
              type="button"
              onClick={() => state.toggle(task.id)}
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} ${childCount} sub-task${childCount === 1 ? "" : "s"}`}
              title={`${node.descendants} task${node.descendants === 1 ? "" : "s"} below`}
              className="hover-linger relative z-10 flex h-6 items-center gap-0.5 rounded-md px-1.5 font-mono tabular-nums outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {childCount}
              <ChevronDown
                aria-hidden
                className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
              />
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** Links that are not the parent edge: the workflow run, the schedule, the tasks it waited on. */
function TaskLinks({ task }: { task: AgentTask }) {
  const chips: ReactNode[] = [];
  if (task.workflowRunId) {
    chips.push(
      <LinkChip key="run" to={`/workflow-runs/${task.workflowRunId}`} label="Open its workflow run">
        <Workflow aria-hidden className="size-3.5" />
      </LinkChip>,
    );
  }
  if (task.scheduleId) {
    chips.push(
      <LinkChip key="schedule" to={`/schedules/${task.scheduleId}`} label="Open its schedule">
        <CalendarClock aria-hidden className="size-3.5" />
      </LinkChip>,
    );
  }
  if (task.dependsOn.length > 0) {
    chips.push(
      <Tooltip key="deps">
        <TooltipTrigger asChild>
          <span className="relative z-10 flex h-6 items-center gap-0.5 rounded-md px-1 font-mono tabular-nums">
            <Link2 aria-hidden className="size-3.5" />
            {task.dependsOn.length}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Waited on {task.dependsOn.map((id) => `#${id.slice(0, 8)}`).join(", ")}
        </TooltipContent>
      </Tooltip>,
    );
  }
  return chips;
}

function LinkChip({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={to}
          aria-label={label}
          className="hover-linger relative z-10 flex size-6 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {children}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
