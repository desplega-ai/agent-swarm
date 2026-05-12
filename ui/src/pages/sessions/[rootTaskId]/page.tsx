/**
 * Sessions surface — `/sessions/:rootTaskId` detail route.
 *
 * Embeds the shared <SessionsShell> (sidebar + mobile select + collapse +
 * search + new-session navigation), with the right pane composed of:
 *   - A single editorial header strip (serif title + quiet meta caption).
 *   - The chronological session timeline.
 *   - A floating <ComposerDock>-backed <SessionComposer> at the bottom.
 */

import { ChevronDown, Eye, EyeOff } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSession } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { SessionComposer } from "@/components/sessions/session-composer";
import { SessionTimeline } from "@/components/sessions/session-timeline";
import { SessionsShell } from "@/components/sessions/sessions-shell";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { useLocalToggle } from "@/hooks/use-local-toggle";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export default function SessionDetailPage() {
  const { rootTaskId } = useParams<{ rootTaskId: string }>();
  const gate = useFeatureGate("1.76.0");
  const { data: detail, isLoading: detailLoading } = useSession(rootTaskId);
  const { data: users } = useUsers();
  const { data: costs } = useSessionCosts({ taskId: rootTaskId, enabled: !!rootTaskId });

  const latestLeafTaskId = useMemo(() => {
    if (!detail || detail.chain.length === 0) return null;
    const sorted = [...detail.chain].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sorted[0]?.id ?? detail.root.id;
  }, [detail]);

  const requestedByUserName = useMemo(() => {
    if (!detail?.root.requestedByUserId || !users) return null;
    return users.find((u) => u.id === detail.root.requestedByUserId)?.name ?? null;
  }, [detail, users]);

  const totalCost = costs?.reduce((sum, c) => sum + c.totalCostUsd, 0) ?? 0;

  // Signature changes whenever the chain shape changes (new task) or any
  // existing task's status/output updates. Stable when polling returns the
  // same data, so auto-scroll doesn't fire on no-op refetches.
  const chainSignature = useMemo(
    () => detail?.chain.map((t) => `${t.id}:${t.status}:${t.lastUpdatedAt}`).join(",") ?? "",
    [detail?.chain],
  );

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { isFollowing, scrollToBottom } = useAutoScroll(scrollEl, [chainSignature]);

  // Off by default — internal handoff/review tasks (`source=system`,
  // `taskType=follow-up`) are operational, not conversational. Power users
  // can flip the toggle to see the full chain. Persisted per-deployment.
  const [showInternalHandoffs, setShowInternalHandoffs] = useLocalToggle(
    "sessions:show-internal-handoffs",
    false,
  );

  // Show the toggle only when the chain actually contains hidden rows —
  // otherwise it's a control with nothing to control.
  const hasInternalHandoffs = useMemo(
    () => detail?.chain.some((t) => t.source === "system" && t.taskType === "follow-up") ?? false,
    [detail?.chain],
  );

  if (!gate.supported) {
    return (
      <UpgradeRequired
        feature="Sessions"
        requiredVersion={gate.requiredVersion}
        currentVersion={gate.currentVersion}
      />
    );
  }

  if (!rootTaskId) {
    return (
      <SessionsShell>
        <p className="text-muted-foreground p-3">Missing session id.</p>
      </SessionsShell>
    );
  }

  return (
    <SessionsShell activeRootTaskId={rootTaskId}>
      {/* Editorial header — serif title + quiet meta caption. Single 72px
          band, no double divider. */}
      <header className="flex flex-col gap-1 border-b border-border px-6 pt-4 pb-3 shrink-0 min-w-0 bg-background">
        {detailLoading ? (
          <Skeleton className="h-6 w-72" />
        ) : detail ? (
          <h1
            className="text-lg md:text-xl font-semibold leading-tight text-foreground truncate"
            title={detail.root.task}
          >
            {detail.root.task}
          </h1>
        ) : (
          <p className="text-sm text-muted-foreground">Session not found.</p>
        )}
        {detail ? (
          <div className="flex items-center gap-2.5 text-xs text-muted-foreground min-w-0 overflow-x-auto">
            <StatusBadge status={detail.root.status} />
            <span>
              {detail.chain.length} task{detail.chain.length === 1 ? "" : "s"}
            </span>
            {requestedByUserName ? (
              <>
                <span aria-hidden="true">·</span>
                <span>by {requestedByUserName}</span>
              </>
            ) : null}
            {totalCost > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{usdFormatter.format(totalCost)}</span>
              </>
            ) : null}
            {hasInternalHandoffs ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setShowInternalHandoffs(!showInternalHandoffs)}
                    className="ml-auto inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    aria-pressed={showInternalHandoffs}
                  >
                    {showInternalHandoffs ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                    <span>Handoffs · {showInternalHandoffs ? "On" : "Off"}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {showInternalHandoffs
                    ? "Hide auto-spawned review tasks"
                    : "Show auto-spawned review tasks as full rows"}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* Timeline (scrollable) — wrapped in a relative container so the
          "Jump to latest" button can float over its bottom-right corner
          when the user has scrolled away from the tail. */}
      <div className="relative flex-1 min-h-0">
        <div ref={setScrollEl} className="absolute inset-0 overflow-auto px-6 py-6">
          {detailLoading ? (
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

        {/* Floating "back to bottom" — only when user has scrolled up. */}
        {!isFollowing ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={scrollToBottom}
            className="absolute bottom-3 right-4 h-8 rounded-full px-3 shadow-md bg-card/90 backdrop-blur-sm"
            aria-label="Jump to latest"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            <span className="text-xs">Latest</span>
          </Button>
        ) : null}
      </div>

      {/* Composer dock pinned to bottom */}
      <SessionComposer rootTaskId={rootTaskId} latestLeafTaskId={latestLeafTaskId} />
    </SessionsShell>
  );
}
