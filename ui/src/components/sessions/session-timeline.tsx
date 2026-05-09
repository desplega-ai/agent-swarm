/**
 * Sessions surface (Phase 4 ≥1.76.0) — chronological timeline of a task chain.
 *
 * Algorithm:
 *  1. Identify the root: task whose `parentTaskId` is `null` AND id matches
 *     `rootTaskId`. Other `parentTaskId === null` rows are anomalies — render
 *     them in an "orphan" footer with a `console.warn` (defensive — should
 *     not happen if the chain endpoint is correct).
 *  2. Build `childrenByParent: Map<string, AgentTask[]>` and sort each list
 *     by `createdAt`.
 *  3. Recursive render: for each parent, walk children in `createdAt` order.
 *     - If `length === 1`, render the child inline.
 *     - If `length >= 2`, wrap them in <ParallelGroup count={N}>. Their own
 *       children render outside the group, continuing the chain naturally.
 *  4. Mixed sequential + parallel + nested handled naturally by recursion.
 *  5. Empty case: chain.length === 0 (or root only) renders the empty session
 *     state with a "Start typing below" hint focused on the composer.
 */

import { MessageSquarePlus } from "lucide-react";
import { useMemo } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { ParallelGroup, TaskCard } from "./task-card";

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

  // Sort each child list by createdAt (spawn order — NOT completion order;
  // completion can interleave and would mislead the reader).
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return { root, childrenByParent, orphans };
}

interface SubtreeProps {
  task: AgentTask;
  childrenByParent: Map<string, AgentTask[]>;
  insideParallelGroup?: boolean;
}

/** Renders the descendants of `task` (NOT `task` itself — the parent renders that). */
function ChildrenChain({ task, childrenByParent }: SubtreeProps) {
  const children = childrenByParent.get(task.id) ?? [];
  if (children.length === 0) return null;

  if (children.length === 1) {
    const child = children[0];
    return (
      <>
        <TaskCard task={child} />
        <ChildrenChain task={child} childrenByParent={childrenByParent} />
      </>
    );
  }

  // 2+ siblings → parallel group. Each sibling's own descendants render
  // OUTSIDE the group (the chain naturally continues from each branch — but
  // since the chain is a tree, only one branch tends to extend; rendering all
  // continuations sequentially after the group preserves chronological order
  // by createdAt across branches).
  return (
    <>
      <ParallelGroup count={children.length}>
        {children.map((child) => (
          <TaskCard key={child.id} task={child} insideParallelGroup />
        ))}
      </ParallelGroup>
      {children.map((child) => (
        <ChildrenChain key={child.id} task={child} childrenByParent={childrenByParent} />
      ))}
    </>
  );
}

export function SessionTimeline({ rootTaskId, chain, className }: SessionTimelineProps) {
  const tree = useMemo(() => buildTimelineTree(rootTaskId, chain), [rootTaskId, chain]);
  const { data: users } = useUsers();
  const requesterName = useMemo(() => {
    const requestedByUserId = tree.root?.requestedByUserId;
    if (!requestedByUserId || !users) return null;
    return users.find((u) => u.id === requestedByUserId)?.name ?? null;
  }, [tree.root, users]);

  if (tree.orphans.length > 0) {
    // Defensive — chain endpoint should never return foreign roots.
    console.warn(
      `[SessionTimeline] received ${tree.orphans.length} orphan root tasks not matching rootTaskId=${rootTaskId}; rendering them in the orphan footer.`,
    );
  }

  // Empty / missing root — fall back to the empty state.
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

  return (
    <div className={className}>
      <div className="flex flex-col gap-3">
        {/* Root user message bubble — the original task text. */}
        <article
          aria-label="Session root message"
          className="min-w-0 overflow-hidden rounded-md border border-border bg-card px-4 py-3"
        >
          <header className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <span className="font-medium text-foreground">{requesterName ?? "User"}</span>
            <span aria-hidden="true">·</span>
            <span>{new Date(root.createdAt).toLocaleString()}</span>
          </header>
          <div className="min-w-0 break-words text-sm [&_pre]:overflow-x-auto [&_pre]:max-w-full">
            <Streamdown>{root.task}</Streamdown>
          </div>
        </article>

        {/* The root is also a task — render it as a card so the user can drill in. */}
        <TaskCard task={root} isRoot />

        {/* Recursive descendants. */}
        <ChildrenChain task={root} childrenByParent={tree.childrenByParent} />

        {!hasChildren && (
          <p className="text-xs text-muted-foreground italic px-1">
            No follow-up tasks yet — the composer below adds the next step.
          </p>
        )}

        {tree.orphans.length > 0 && (
          <section
            aria-label="Orphan tasks"
            className="mt-4 border-t border-border pt-3 flex flex-col gap-2"
          >
            <h4 className="font-mono font-bold text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              Orphan tasks ({tree.orphans.length})
            </h4>
            <p className="text-xs text-muted-foreground">
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
