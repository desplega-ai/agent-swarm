/**
 * Sessions surface — chronological timeline of a session's task chain.
 *
 * Visual model:
 *   1. Tasks created by a human (root prompt + composer follow-ups carry
 *      `requestedByUserId`) split into two parts: a chat-style user-side
 *      bubble (<UserPromptBubble>) followed by an agent-side row
 *      (<TaskCard hideTaskText />) that shows the agent's response.
 *   2. Tasks NOT initiated by a human render as a single agent-side row
 *      with the task text as the body.
 *   3. Sibling tasks sharing a `parentTaskId` collapse into a
 *      <ParallelGroup> with a single muted "N in parallel · via {parent}"
 *      caption — no chrome, just a click-to-collapse header.
 *   4. Auto-spawned "review needed" follow-ups (`source === "system"` and
 *      `taskType === "follow-up"`) are hidden by default — the system
 *      generates these to nudge the Lead after a worker finishes, but they
 *      add no conversational value. They collapse into a `<ReviewAck>` chip
 *      attached to the worker row they reviewed. Use the page-level
 *      "Show handoffs" toggle to bring them back as full rows.
 */

import { CornerLeftUp, MessageSquarePlus } from "lucide-react";
import { useMemo } from "react";
import { useAgent } from "@/api/hooks/use-agents";
import type { AgentTask } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { cn, formatRelativeTime } from "@/lib/utils";
import { ParallelGroup, TaskCard, TaskOutcome } from "./task-card";
import { UserPromptBubble } from "./user-prompt-bubble";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * `true` for the orchestrator's auto-spawned review follow-ups —
 * "Worker task completed — review needed." rows. Identified structurally
 * by the wire fields, not by sniffing task text.
 */
function isAutoReview(task: AgentTask): boolean {
  return task.source === "system" && task.taskType === "follow-up";
}

/**
 * Quiet closing block rendered after a parent task's direct children when
 * the parent itself reached a terminal state and finished AFTER its
 * children. The block has two parts:
 *   1. A small chip header — "↩ Lead closed this fork · finished Xm ago"
 *   2. The parent's actual outcome (`<TaskOutcome>`) directly under the
 *      chip. Since the parent rendered its row at the top of the fork
 *      WITHOUT its outcome (`deferOutput`), the outcome lands here in its
 *      true chronological position.
 */
function ParentClosingChip({ parent }: { parent: AgentTask }) {
  const { data: agent } = useAgent(parent.agentId ?? "");
  const name = agent?.name ?? (parent.agentId ? `${parent.agentId.slice(0, 8)}…` : "Agent");
  return (
    <div data-slot="parent-closing-chip" className="ml-9 mt-1 flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/80">
        <CornerLeftUp className="h-3 w-3 shrink-0" aria-hidden="true" />
        <AgentAvatar
          agentId={parent.agentId}
          agentName={agent?.name}
          size="xs"
          className="shrink-0"
        />
        <span>
          <span className="text-foreground/80 font-medium">{name}</span>
          {parent.status === "completed"
            ? " closed this fork"
            : parent.status === "failed"
              ? " gave up here"
              : " was cancelled"}
          <span className="text-muted-foreground/70">
            {" · finished "}
            <time
              dateTime={parent.lastUpdatedAt}
              title={new Date(parent.lastUpdatedAt).toLocaleString()}
            >
              {formatRelativeTime(parent.lastUpdatedAt)}
            </time>
          </span>
        </span>
      </div>
      {/* Parent's actual outcome — rendered here instead of inside the
          parent's TaskCard so it shows up in chronological position. */}
      <div className="pl-5 min-w-0">
        <TaskOutcome task={parent} />
      </div>
    </div>
  );
}

/**
 * `true` when the parent has at least one direct child AND its own
 * `lastUpdatedAt` lands strictly later than every direct child's
 * `lastUpdatedAt`.
 *
 * We deliberately ONLY check direct children. Indirect descendants don't
 * count because in this codebase every follow-up turn chains under the
 * previous task via `parentTaskId` — so a 30-minutes-later "Nice" reply
 * becomes a descendant of the original Lead task and would otherwise
 * suppress the chip. The semantics we want is "parent closed *its own*
 * wait loop after its direct children", which matches direct fan-in only.
 */
function parentClosedAfterDirectChildren(
  parent: AgentTask,
  childrenByParent: Map<string, AgentTask[]>,
): boolean {
  if (!TERMINAL_STATUSES.has(parent.status)) return false;
  const directChildren = childrenByParent.get(parent.id) ?? [];
  if (directChildren.length === 0) return false;
  const parentTs = Date.parse(parent.lastUpdatedAt);
  if (!Number.isFinite(parentTs)) return false;
  for (const child of directChildren) {
    const ts = Date.parse(child.lastUpdatedAt);
    if (!Number.isFinite(ts)) return false;
    if (ts >= parentTs) return false;
  }
  return true;
}

export interface SessionTimelineProps {
  rootTaskId: string;
  chain: AgentTask[];
  /** When `true`, render auto-review (`source=system`, `taskType=follow-up`)
   *  rows as full turns. When `false` (default), hide them and surface a
   *  `<ReviewAck>` chip under the worker row they reviewed. */
  showInternalHandoffs?: boolean;
  className?: string;
}

interface TimelineTree {
  root: AgentTask | null;
  childrenByParent: Map<string, AgentTask[]>;
  /** Hidden auto-review tasks grouped by the worker (the review's parent)
   *  they reviewed. Keyed by the *visible* worker's task id. */
  acksByWorker: Map<string, AgentTask[]>;
  orphans: AgentTask[];
}

function buildTimelineTree(
  rootTaskId: string,
  chain: AgentTask[],
  opts: { hideAutoReviews: boolean },
): TimelineTree {
  const byId = new Map<string, AgentTask>(chain.map((t) => [t.id, t]));

  // First pass: which tasks are hidden? In the default mode every auto-review
  // is hidden; in "show handoffs" mode none are.
  const hidden = new Set<string>();
  if (opts.hideAutoReviews) {
    for (const task of chain) {
      if (isAutoReview(task)) hidden.add(task.id);
    }
  }

  // When we hide a node, its children re-parent to the nearest visible
  // ancestor. This walks up the parent chain skipping hidden nodes.
  const resolveVisibleParent = (parentId: string | null | undefined): string | null => {
    let p = parentId ?? null;
    while (p && hidden.has(p)) {
      const t = byId.get(p);
      p = t?.parentTaskId ?? null;
    }
    return p ?? null;
  };

  const childrenByParent = new Map<string, AgentTask[]>();
  const acksByWorker = new Map<string, AgentTask[]>();
  let root: AgentTask | null = null;
  const orphans: AgentTask[] = [];

  for (const task of chain) {
    if (hidden.has(task.id)) {
      // Attach the ack to the closest visible ancestor (typically the
      // worker the review was about). If that worker is itself hidden
      // (unusual), the ack rolls up to whatever sits above in the chain.
      const worker = resolveVisibleParent(task.parentTaskId);
      if (worker) {
        const list = acksByWorker.get(worker);
        if (list) list.push(task);
        else acksByWorker.set(worker, [task]);
      }
      continue;
    }
    if (task.parentTaskId == null) {
      if (task.id === rootTaskId) root = task;
      else orphans.push(task);
      continue;
    }
    const visibleParent = resolveVisibleParent(task.parentTaskId);
    if (visibleParent == null) {
      // Parent chain dissolves into hidden nodes all the way up — extremely
      // unlikely (the root is `source: "ui"`, never hidden) but route to
      // orphan rather than dropping silently.
      if (task.id === rootTaskId) root = task;
      else orphans.push(task);
      continue;
    }
    const list = childrenByParent.get(visibleParent);
    if (list) list.push(task);
    else childrenByParent.set(visibleParent, [task]);
  }

  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  for (const list of acksByWorker.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return { root, childrenByParent, acksByWorker, orphans };
}

/**
 * Renders a single task as either:
 *   - A user-bubble + agent-row pair (when the task originated from a human
 *     typing into the UI composer — `source === "ui"`), or
 *   - A single agent-row showing the task text as the body (everything
 *     else: Lead-spawned children, slack threads, scheduled jobs, etc.).
 *
 * `requestedByUserId` propagates to children via spawn-task, so it isn't a
 * reliable signal of "this came from a human"; `source` is.
 */
function TaskTurn({
  task,
  parentAgentId,
  insideParallelGroup,
  deferOutput,
  reviewAcks,
}: {
  task: AgentTask;
  /** Agent who owned the parent task — used to render "via X" delegation hint. */
  parentAgentId?: string | null;
  insideParallelGroup?: boolean;
  /** When true, the task's `<TaskOutcome>` is suppressed in this row — it
   *  will be re-rendered later inside the closing chip. */
  deferOutput?: boolean;
  /** Hidden auto-review tasks attached to this worker — collapsed into a
   *  single `<ReviewAck>` chip under the outcome. */
  reviewAcks?: AgentTask[];
}) {
  const isUserTyped = task.source === "ui";
  return (
    <>
      {isUserTyped ? (
        <UserPromptBubble
          text={task.task}
          requestedByUserId={task.requestedByUserId}
          createdAt={task.createdAt}
        />
      ) : null}
      <TaskCard
        task={task}
        hideTaskText={isUserTyped}
        insideParallelGroup={insideParallelGroup}
        // Suppress the "↳ via X" delegation hint on user-typed turns —
        // it would (mis)imply the previous agent delegated TO the agent
        // replying to the user, which is conceptually backwards.
        parentAgentId={isUserTyped ? null : parentAgentId}
        deferOutput={deferOutput}
        reviewAcks={reviewAcks}
      />
    </>
  );
}

interface SubtreeProps {
  task: AgentTask;
  childrenByParent: Map<string, AgentTask[]>;
  acksByWorker: Map<string, AgentTask[]>;
}

function ChildrenChain({ task, childrenByParent, acksByWorker }: SubtreeProps) {
  const children = childrenByParent.get(task.id) ?? [];
  if (children.length === 0) return null;
  const parentAgentId = task.agentId;

  // Closer renders RIGHT AFTER the direct children — before recursing into
  // their downstream chains. That way "↩ Lead closed this fork" lands
  // immediately under the child(ren) the parent was waiting on. Whenever
  // the closer fires we also defer the parent's TaskOutcome to render
  // attached to the closer (chronologically correct).
  const showCloser = parentClosedAfterDirectChildren(task, childrenByParent);

  if (children.length === 1) {
    const child = children[0];
    const childDefers = parentClosedAfterDirectChildren(child, childrenByParent);
    return (
      <>
        <TaskTurn
          task={child}
          parentAgentId={parentAgentId}
          deferOutput={childDefers}
          reviewAcks={acksByWorker.get(child.id)}
        />
        {showCloser ? <ParentClosingChip parent={task} /> : null}
        <ChildrenChain
          task={child}
          childrenByParent={childrenByParent}
          acksByWorker={acksByWorker}
        />
      </>
    );
  }

  return (
    <>
      <ParallelGroup count={children.length} parentAgentId={parentAgentId}>
        {children.map((child) => {
          const childDefers = parentClosedAfterDirectChildren(child, childrenByParent);
          return (
            <TaskTurn
              key={child.id}
              task={child}
              // Suppress the per-child "↳ via X" hint — the parallel group's
              // caption already says "N in parallel · via {parent}".
              parentAgentId={null}
              insideParallelGroup
              deferOutput={childDefers}
              reviewAcks={acksByWorker.get(child.id)}
            />
          );
        })}
      </ParallelGroup>
      {showCloser ? <ParentClosingChip parent={task} /> : null}
      {children.map((child) => (
        <ChildrenChain
          key={child.id}
          task={child}
          childrenByParent={childrenByParent}
          acksByWorker={acksByWorker}
        />
      ))}
    </>
  );
}

export function SessionTimeline({
  rootTaskId,
  chain,
  showInternalHandoffs = false,
  className,
}: SessionTimelineProps) {
  const tree = useMemo(
    () => buildTimelineTree(rootTaskId, chain, { hideAutoReviews: !showInternalHandoffs }),
    [rootTaskId, chain, showInternalHandoffs],
  );

  if (tree.orphans.length > 0) {
    console.warn(
      `[SessionTimeline] received ${tree.orphans.length} orphan root tasks not matching rootTaskId=${rootTaskId}; rendering them in the orphan footer.`,
    );
  }

  if (!tree.root) {
    return (
      <div className={className}>
        <EmptyState
          icon={MessageSquarePlus}
          title="No messages yet"
          description="Start typing below to send the first message in this session."
        />
      </div>
    );
  }

  const root = tree.root;
  const hasChildren = (tree.childrenByParent.get(root.id)?.length ?? 0) > 0;
  const rootDefers = parentClosedAfterDirectChildren(root, tree.childrenByParent);

  return (
    <div className={cn("max-w-3xl mx-auto w-full", className)}>
      {/* Single timeline column — no spine. Each row's `pb-*` provides the
          rhythm between turns; grouping comes from indentation + the
          parallel-group caption. */}
      <div className="flex flex-col">
        <TaskTurn
          task={root}
          deferOutput={rootDefers}
          reviewAcks={tree.acksByWorker.get(root.id)}
        />
        <ChildrenChain
          task={root}
          childrenByParent={tree.childrenByParent}
          acksByWorker={tree.acksByWorker}
        />

        {!hasChildren && root.status === "completed" ? (
          <p className="text-xs text-muted-foreground italic pl-12">
            Reply below to continue the session.
          </p>
        ) : null}

        {tree.orphans.length > 0 && (
          <section
            aria-label="Orphan tasks"
            className="mt-4 border-t border-border pt-3 flex flex-col"
          >
            <h4 className="font-mono font-bold text-[10px] uppercase tracking-[0.08em] text-muted-foreground mb-2">
              Orphan tasks ({tree.orphans.length})
            </h4>
            <p className="text-xs text-muted-foreground mb-3">
              These tasks have no parent and don't match the session root — likely a chain-fetch
              bug. Rendering for visibility.
            </p>
            {tree.orphans.map((o) => (
              <TaskCard key={o.id} task={o} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
