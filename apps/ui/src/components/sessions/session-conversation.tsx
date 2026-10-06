/**
 * Sessions surface: the conversation of one session: the live timeline, a
 * "Latest" jump button, and the composer (follow-up, steering, attachments).
 * The `/sessions/:rootTaskId` page and the contextual session panel both
 * render this, so they behave the same.
 */

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSession } from "@/api/hooks/use-sessions";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import { TaskComposer, type TaskComposerProps } from "@/components/shared/task-composer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { canSteerSessionTask } from "@/lib/task-steer";
import { cn } from "@/lib/utils";
import { SessionTimeline } from "./session-timeline";

export interface SessionConversationProps {
  rootTaskId: string;
  /** Render auto-spawned review follow-ups as full rows. */
  showInternalHandoffs?: boolean;
  /** Classes for the scrolling timeline area (padding). */
  scrollClassName?: string;
  /** Extra composer action-row buttons; see `TaskComposerProps.renderActions`. */
  renderComposerActions?: TaskComposerProps["renderActions"];
}

export function SessionConversation({
  rootTaskId,
  showInternalHandoffs = false,
  scrollClassName,
  renderComposerActions,
}: SessionConversationProps) {
  // Steering (≥1.122.1). Older servers 404 `/api/tasks/:id/steer`, so the
  // composer falls back to its pre-steering chained-task behaviour.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: detail, isLoading } = useSession(rootTaskId);

  // The whole leaf task, not just its id: the composer needs `status`,
  // `isLeadTask`, `provider`, and `supportedSteerModes` to decide between
  // steering the running task and chaining a new one (decision 6).
  const latestLeafTask = useMemo(() => {
    if (!detail || detail.chain.length === 0) return null;
    const sorted = [...detail.chain].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sorted[0] ?? detail.root;
  }, [detail]);

  // Signature changes whenever the chain shape changes (new task) or any
  // existing task's status/output updates. Stable when polling returns the
  // same data, so auto-scroll doesn't fire on no-op refetches.
  const chainSignature = useMemo(
    () => detail?.chain.map((t) => `${t.id}:${t.status}:${t.lastUpdatedAt}`).join(",") ?? "",
    [detail?.chain],
  );

  // Sessions steers only the latest *lead* task (decision 6).
  const canSteer = steerGate.supported && steeringEnabled && canSteerSessionTask(latestLeafTask);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isFollowing, scrollToBottom } = useAutoScroll(scrollEl, [chainSignature]);

  return (
    <>
      {/* Timeline (scrollable), wrapped in a relative container so the
          "Jump to latest" button can sit on its bottom edge, where the
          composer starts, when the user has scrolled away from the tail. */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={setScrollEl}
          className={cn("absolute inset-0 overflow-auto px-6 py-6", scrollClassName)}
        >
          {isLoading ? (
            <div className="flex flex-col gap-3 max-w-3xl mx-auto w-full">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : detail ? (
            <SessionTimeline
              rootTaskId={rootTaskId}
              chain={detail.chain}
              showInternalHandoffs={showInternalHandoffs}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Couldn't load this session. It may have been deleted, or the API server is offline.
            </p>
          )}
        </div>

        {/* "Back to bottom", only when the user has scrolled up. It sits on
            the composer's top edge (half over the log's bottom padding), so
            it never covers a log row or its timestamp. */}
        {!isFollowing ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={scrollToBottom}
            className="absolute bottom-0 left-1/2 z-10 h-8 -translate-x-1/2 translate-y-1/2 rounded-full px-3 shadow-sm bg-card"
            aria-label="Jump to latest"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            <span className="text-xs">Latest</span>
          </Button>
        ) : null}
      </div>

      {/* Composer dock pinned to bottom */}
      <TaskComposer
        rootTaskId={rootTaskId}
        targetTask={latestLeafTask}
        canSteer={canSteer}
        placeholder="Continue the session…"
        renderActions={renderComposerActions}
      />
    </>
  );
}
