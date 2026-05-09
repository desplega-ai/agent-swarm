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
 *      <ParallelGroup> with a visible left rail and "N in parallel" header.
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
  className?: string;
}

interface TimelineTree {
  root: AgentTask | null;
  childrenByParent: Map<string, AgentTask[]>;
  orphans: AgentTask[];
}

function buildTimelineTree(rootTaskId: string, chain: AgentTask[]): TimelineTree {
  const childrenByParent = new Map<string, AgentTask[]>();
  let root: AgentTask | null = null;
  const orphans: AgentTask[] = [];

  for (const task of chain) {
    if (task.parentTaskId == null) {
      if (task.id === rootTaskId) {
        root = task;
      } else {
        orphans.push(task);
      }
      continue;
    }
    const list = childrenByParent.get(task.parentTaskId);
    if (list) {
      list.push(task);
    } else {
      childrenByParent.set(task.parentTaskId, [task]);
    }
  }

  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return { root, childrenByParent, orphans };
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
}: {
  task: AgentTask;
  /** Agent who owned the parent task — used to render "via X" delegation hint. */
  parentAgentId?: string | null;
  insideParallelGroup?: boolean;
  /** When true, the task's `<TaskOutcome>` is suppressed in this row — it
   *  will be re-rendered later inside the closing chip. */
  deferOutput?: boolean;
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
        parentAgentId={parentAgentId}
        deferOutput={deferOutput}
      />
    </>
  );
}

interface SubtreeProps {
  task: AgentTask;
  childrenByParent: Map<string, AgentTask[]>;
}

function ChildrenChain({ task, childrenByParent }: SubtreeProps) {
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
        <TaskTurn task={child} parentAgentId={parentAgentId} deferOutput={childDefers} />
        {showCloser ? <ParentClosingChip parent={task} /> : null}
        <ChildrenChain task={child} childrenByParent={childrenByParent} />
      </>
    );
  }

  return (
    <>
      <ParallelGroup count={children.length}>
        {children.map((child) => {
          const childDefers = parentClosedAfterDirectChildren(child, childrenByParent);
          return (
            <TaskTurn
              key={child.id}
              task={child}
              parentAgentId={parentAgentId}
              insideParallelGroup
              deferOutput={childDefers}
            />
          );
        })}
      </ParallelGroup>
      {showCloser ? <ParentClosingChip parent={task} /> : null}
      {children.map((child) => (
        <ChildrenChain key={child.id} task={child} childrenByParent={childrenByParent} />
      ))}
    </>
  );
}

export function SessionTimeline({ rootTaskId, chain, className }: SessionTimelineProps) {
  const tree = useMemo(() => buildTimelineTree(rootTaskId, chain), [rootTaskId, chain]);

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
      {/* Single timeline column — agent rows draw their own spine fragments
          (so user bubbles don't sit on a stray line). Adjacent rows touch
          via padding-bottom on each row, forming a continuous spine. */}
      <div className="flex flex-col">
        <TaskTurn task={root} deferOutput={rootDefers} />
        <ChildrenChain task={root} childrenByParent={tree.childrenByParent} />

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
