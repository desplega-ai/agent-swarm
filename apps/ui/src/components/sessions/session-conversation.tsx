/**
 * Sessions surface: the conversation of one session: the live timeline, a
 * "Latest" jump button, and the composer (follow-up, steering, attachments).
 * The `/sessions/:rootTaskId` page, the sessions v2 pane, and the contextual
 * session panel all render this, so they behave the same. `timeline` picks
 * the legacy task tree or the v2 turn timeline (plan D15).
 */

import { ChevronDown, Lock } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { sessionErrorStatus, useSession } from "@/api/hooks/use-sessions";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import { TurnTimeline } from "@/components/sessions-v2/pane/turn-timeline";
import { EmptyState } from "@/components/shared/empty-state";
import { TaskComposer, type TaskComposerProps } from "@/components/shared/task-composer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { typingLabel } from "@/lib/session-presence";
import { isReadOnlyAccess } from "@/lib/session-sharing";
import { canSteerSessionTask } from "@/lib/task-steer";
import { cn } from "@/lib/utils";
import { ComposerReadOnlyNotice } from "./composer-dock";
import { useSessionPresenceContext } from "./session-presence";
import { SessionTimeline } from "./session-timeline";

export interface SessionConversationProps {
  rootTaskId: string;
  /** Render auto-spawned review follow-ups as full rows. */
  showInternalHandoffs?: boolean;
  /** Classes for the scrolling timeline area (padding). */
  scrollClassName?: string;
  /** Extra composer action-row buttons; see `TaskComposerProps.renderActions`. */
  renderComposerActions?: TaskComposerProps["renderActions"];
  /** `turns`: the sessions v2 turn timeline. `legacy`: the task tree of the legacy view. */
  timeline?: "legacy" | "turns";
  /**
   * The phone composer: the one-line bar with 44 px buttons (`TaskComposer
   * bar`), and classes for its dock (the safe-area inset).
   */
  composer?: { bar?: boolean; className?: string };
}

const SCROLLED_UP_FADE = {
  maskImage: "linear-gradient(to bottom, black calc(100% - 1rem), transparent)",
} as const;

export function SessionConversation({
  rootTaskId,
  showInternalHandoffs = false,
  scrollClassName,
  renderComposerActions,
  timeline = "legacy",
  composer: composerLayout,
}: SessionConversationProps) {
  // Steering (≥1.122.1). Older servers 404 `/api/tasks/:id/steer`, so the
  // composer falls back to its pre-steering chained-task behaviour.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: detail, isLoading, error } = useSession(rootTaskId);
  // A 403 wins over cached data, so a viewer whose share was revoked loses
  // the conversation on the next poll instead of keeping a stale copy.
  const noAccess = sessionErrorStatus(error) === 403;
  const { viewers, setTyping } = useSessionPresenceContext();
  const typing = typingLabel(viewers);
  const turns = timeline === "turns";
  const typingViewers = useMemo(() => viewers.filter((viewer) => viewer.typing), [viewers]);

  // Typing = the composer has focus and holds text. The steer box and the
  // follow-up dock swap under a typing user, so track both on a wrapper.
  const composer = useRef({ focused: false, hasText: false });
  const reportTyping = useCallback(() => {
    setTyping(composer.current.focused && composer.current.hasText);
  }, [setTyping]);
  const canType = !noAccess && !isReadOnlyAccess(detail?.access);
  // The composer can unmount mid-typing when access drops to read; clear the
  // flag so others never see a stuck "typing…".
  useEffect(() => {
    if (canType) return;
    composer.current = { focused: false, hasText: false };
    setTyping(false);
  }, [canType, setTyping]);

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

  // The turn timeline also grows with a typing bubble and an approval line.
  const flowSignature = turns
    ? `${typingViewers.map((viewer) => viewer.id).join(",")}|${(detail?.approvals ?? []).map((approval) => approval.id).join(",")}`
    : "";

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isFollowing, scrollToBottom, recheck } = useAutoScroll(scrollEl, [
    chainSignature,
    flowSignature,
  ]);

  // Turns: open each session at its newest line at once. A smooth scroll from
  // the top passes the follow threshold, so the Latest strip would flash.
  const openedAt = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!turns || !scrollEl || detail?.root.id !== rootTaskId) return;
    if (openedAt.current === rootTaskId) return;
    openedAt.current = rootTaskId;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }, [turns, scrollEl, detail, rootTaskId]);

  return (
    <>
      {/* Timeline (scrollable), wrapped in a relative container so the
          "Jump to latest" button can sit on its bottom edge, where the
          composer starts, when the user has scrolled away from the tail. */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={setScrollEl}
          className={cn(
            "absolute inset-0 overflow-auto px-6 py-6",
            // Turns: while scrolled up, the "Latest" pill gets its own strip
            // above the composer, so it never covers a message or the typing
            // bubble (SPEC R10.4).
            turns && !isFollowing && "bottom-11",
            scrollClassName,
          )}
          // The cut above the strip fades instead of slicing a message.
          style={turns && !isFollowing ? SCROLLED_UP_FADE : undefined}
        >
          {isLoading ? (
            <div className="flex flex-col gap-3 max-w-3xl mx-auto w-full">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : noAccess ? (
            <SessionNoAccess />
          ) : detail ? (
            turns ? (
              <TurnTimeline
                rootTaskId={rootTaskId}
                chain={detail.chain}
                approvals={detail.approvals ?? []}
                showHandoffs={showInternalHandoffs}
                typing={typingViewers}
                onLayoutChange={recheck}
              />
            ) : (
              <SessionTimeline
                rootTaskId={rootTaskId}
                chain={detail.chain}
                showInternalHandoffs={showInternalHandoffs}
              />
            )
          ) : (
            <p className="text-xs text-muted-foreground">
              Couldn't load this session. It may have been deleted, or the API server is offline.
            </p>
          )}
        </div>

        {/* "Back to bottom", only when the user has scrolled up. Legacy: on
            the composer's top edge (half over the log's bottom padding).
            Turns: in the strip the timeline frees, 10 px above the composer
            box (the dock's 8 px top padding plus 2 px). */}
        {!isFollowing ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={scrollToBottom}
            className={cn(
              "absolute left-1/2 z-10 h-8 -translate-x-1/2 rounded-full px-3 shadow-sm bg-card",
              // A touch screen: a 44 px tap area around the 32 px pill (UX review R9).
              "pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1.5",
              turns ? "bottom-0.5" : "bottom-0 translate-y-1/2",
            )}
            aria-label="Jump to latest"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            <span className="text-xs">Latest</span>
          </Button>
        ) : null}
      </div>

      {turns ? (
        // The typing bubble in the timeline is decoration. Its words go here.
        <p aria-live="polite" className="sr-only">
          {typing ?? ""}
        </p>
      ) : typing ? (
        <p
          aria-live="polite"
          className="shrink-0 px-6 pt-2 text-xs text-muted-foreground max-w-3xl mx-auto w-full"
        >
          {typing}
        </p>
      ) : null}

      {/* Composer dock pinned to bottom. A read-only share gets a notice
          instead; a missing `access` (older servers) keeps the composer. */}
      {noAccess ? null : isReadOnlyAccess(detail?.access) ? (
        <ComposerReadOnlyNotice
          message={`View only. Shared by ${detail?.owner?.name ?? "the owner"}.`}
        />
      ) : (
        <div
          className="contents"
          onFocus={() => {
            composer.current.focused = true;
            reportTyping();
          }}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            composer.current.focused = false;
            reportTyping();
          }}
        >
          <TaskComposer
            rootTaskId={rootTaskId}
            targetTask={latestLeafTask}
            canSteer={canSteer}
            placeholder="Continue the session…"
            renderActions={renderComposerActions}
            bar={composerLayout?.bar}
            className={composerLayout?.className}
            onValueChange={(next) => {
              composer.current.hasText = next.trim().length > 0;
              reportTyping();
            }}
          />
        </div>
      )}
    </>
  );
}

/** A session that exists but was not shared with this viewer (HTTP 403). */
export function SessionNoAccess() {
  return (
    <EmptyState
      icon={Lock}
      title="You don't have access"
      description="Ask the owner to share it."
    />
  );
}
