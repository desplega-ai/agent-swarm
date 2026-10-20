import { ArrowLeft, Lock, Network, SearchX } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAgents } from "@/api/hooks/use-agents";
import { useTaskLineage } from "@/api/hooks/use-tasks";
import { BetaTag } from "@/components/shared/beta-tag";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  allExpandable,
  buildLineageTree,
  initialExpanded,
  type LineageTree,
  summarizeLineage,
  WIDE_LIMIT,
} from "./lineage-tree";
import { cardCost, LineageView, type LineageViewState } from "./lineage-view";

/** Children a "Show more" click adds. */
const SHOW_MORE_STEP = WIDE_LIMIT * 3;

/**
 * Experimental: the whole tree a task belongs to, from the topmost ancestor
 * down, as cards joined by who-started-whom edges. Linked from the task
 * page's "..." menu; the task page itself is unchanged.
 */
export default function TaskLineagePage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useTaskLineage(id);
  const { data: agents } = useAgents();

  const tree = useMemo(
    () => (data && id ? buildLineageTree(data.tasks, data.rootTaskId, id) : null),
    [data, id],
  );
  const summary = useMemo(() => (data ? summarizeLineage(data.tasks) : null), [data]);
  const agentNames = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  if (isLoading) return <PageSkeleton />;
  const status = (error as { status?: number } | null)?.status;
  if (status === 403) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to this session"
        description="Ask the owner to share it."
      />
    );
  }
  if (!tree || !summary || !id) {
    return (
      <EmptyState
        icon={SearchX}
        title="Task not found"
        description={error ? error.message : "This task has no lineage to show."}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Button asChild variant="ghost" size="icon-sm" aria-label="Back to the task">
              <Link to={`/tasks/${id}`}>
                <ArrowLeft />
              </Link>
            </Button>
            <Network aria-hidden className="size-4 text-muted-foreground" />
            <span className="text-base font-semibold">Lineage</span>
            <BetaTag tooltip="Experimental: every task this one belongs to, and who started whom" />
          </span>
        }
        description={
          <span className="font-mono text-xs tabular-nums">
            {[
              `${summary.tasks} task${summary.tasks === 1 ? "" : "s"}`,
              `${summary.agents} agent${summary.agents === 1 ? "" : "s"}`,
              summary.live > 0 ? `${summary.live} live` : null,
              summary.costUsd > 0 ? cardCost(summary.costUsd) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        }
      />
      {data?.truncated ? (
        <AlertCallout tone="warning" title="Partial tree">
          This tree is larger than the view's limit, so some tasks are not shown.
        </AlertCallout>
      ) : null}
      <LineageCanvas
        key={`${tree.root.task.id}:${id}`}
        tree={tree}
        focusId={id}
        agentNames={agentNames}
      />
    </div>
  );
}

/** The tree with its expand state. Keyed by root and focus, so a new task starts fresh. */
function LineageCanvas({
  tree,
  focusId,
  agentNames,
}: {
  tree: LineageTree;
  focusId: string;
  agentNames: ReadonlyMap<string, string>;
}) {
  const [expanded, setExpanded] = useState(() => initialExpanded(tree));
  const [shownCount, setShownCount] = useState<ReadonlyMap<string, number>>(() => new Map());
  const pathIds = useMemo(() => new Set(tree.path), [tree.path]);

  const toggle = useCallback((taskId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(taskId)) next.add(taskId);
      return next;
    });
  }, []);
  const showMore = useCallback((taskId: string) => {
    setShownCount((prev) => new Map(prev).set(taskId, (prev.get(taskId) ?? 0) + SHOW_MORE_STEP));
  }, []);
  const agentName = useCallback(
    (agentId: string | null | undefined) => (agentId ? (agentNames.get(agentId) ?? null) : null),
    [agentNames],
  );

  const state: LineageViewState = {
    focusId,
    pathIds,
    expanded,
    shownCount,
    toggle,
    showMore,
    agentName,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="xs"
          onClick={() => setExpanded(new Set([tree.root.task.id]))}
        >
          Collapse all
        </Button>
        <Button variant="outline" size="xs" onClick={() => setExpanded(allExpandable(tree))}>
          Expand all
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border-subtle bg-muted/30 pt-6">
        <LineageView root={tree.root} state={state} />
      </div>
    </div>
  );
}
