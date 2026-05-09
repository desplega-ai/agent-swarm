/**
 * Sessions surface (Phase 4 ≥1.76.0) — `/sessions/:rootTaskId` detail route.
 *
 * Layout:
 *   - Left sidebar: SessionsSidebar (shared with /sessions list).
 *   - Right: header strip + scrollable timeline + composer pinned to bottom.
 *
 * Soft-degrade: when `useFeatureGate("1.76.0").supported === false`, this
 * page renders the generic <UpgradeRequired /> page instead.
 */

import { ArrowLeft, MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSession, useSessions } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { SessionComposer } from "@/components/sessions/session-composer";
import { SessionTimeline } from "@/components/sessions/session-timeline";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { SessionsSidebar } from "../page";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export default function SessionDetailPage() {
  const { rootTaskId } = useParams<{ rootTaskId: string }>();
  const gate = useFeatureGate("1.76.0");
  const { data: sessions, isLoading: sessionsLoading } = useSessions({ limit: 50 });
  const { data: detail, isLoading: detailLoading } = useSession(rootTaskId);
  const { data: users } = useUsers();
  const { data: costs } = useSessionCosts({ taskId: rootTaskId, enabled: !!rootTaskId });

  // Latest leaf = the most recently-created task in the chain. The composer
  // chains the next task off of this; falls back to the root.
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
    return <p className="text-muted-foreground p-3">Missing session id.</p>;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 p-1">
      <PageHeader
        title="Sessions"
        icon={MessageSquare}
        description="Chronological task chains — each session = a root task and its descendants."
      />

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 border border-border rounded-md overflow-hidden">
        <aside className="border-r border-border min-h-0 overflow-auto bg-card">
          <SessionsSidebar
            sessions={sessions}
            isLoading={sessionsLoading}
            activeRootTaskId={rootTaskId}
          />
        </aside>

        <section className="flex flex-col min-h-0 min-w-0">
          {/* Header strip */}
          <header className="border-b border-border px-4 py-3 flex flex-col gap-2 min-w-0">
            <div className="flex items-start justify-between gap-3 min-w-0">
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                {detailLoading ? (
                  <Skeleton className="h-4 w-64" />
                ) : detail ? (
                  <h2 className="text-sm font-semibold truncate" title={detail.root.task}>
                    {detail.root.task}
                  </h2>
                ) : (
                  <p className="text-sm text-muted-foreground">Session not found.</p>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {detail ? <StatusBadge status={detail.root.status} /> : null}
                  {detail ? (
                    <span>
                      {detail.chain.length} task{detail.chain.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
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
                </div>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link to="/sessions">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  All sessions
                </Link>
              </Button>
            </div>
          </header>

          {/* Timeline (scrollable) */}
          <div className="flex-1 min-h-0 overflow-auto px-4 py-4">
            {detailLoading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : detail ? (
              <SessionTimeline rootTaskId={rootTaskId} chain={detail.chain} />
            ) : (
              <p className="text-xs text-muted-foreground">
                Couldn't load this session. It may have been deleted, or the API server is offline.
              </p>
            )}
          </div>

          {/* Composer pinned to bottom */}
          <SessionComposer rootTaskId={rootTaskId} latestLeafTaskId={latestLeafTaskId} />
        </section>
      </div>
    </div>
  );
}
