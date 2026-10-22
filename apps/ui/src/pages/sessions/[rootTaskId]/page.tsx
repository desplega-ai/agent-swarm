/**
 * Sessions surface — `/sessions/:rootTaskId` detail route.
 *
 * Embeds the shared <SessionsShell> (sidebar + mobile select + collapse +
 * search + new-session navigation), with the right pane composed of:
 *   - A single editorial header strip (serif title + quiet meta caption).
 *   - <SessionConversation>: the timeline plus the composer, shared with the
 *     contextual session panel.
 */

import { Eye, EyeOff, Pencil } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { sessionErrorStatus, useSession, useUpdateSessionTitle } from "@/api/hooks/use-sessions";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { SessionConversation } from "@/components/sessions/session-conversation";
import { SessionMeta } from "@/components/sessions/session-meta";
import {
  SessionPresenceAvatars,
  SessionPresenceProvider,
} from "@/components/sessions/session-presence";
import { SessionsShell } from "@/components/sessions/sessions-shell";
import { ShareSessionButton } from "@/components/sessions/share-session-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import type { NewViewLink } from "@/hooks/use-sessions-view";
import { SESSION_SHARING_MIN_VERSION } from "@/lib/session-sharing";
import { sessionDisplayTitle } from "@/lib/utils";

/**
 * The legacy detail page. `pages/sessions/page.tsx` renders it for
 * `/sessions/:rootTaskId` when the legacy view is on. `newView` is the
 * "New sessions view" button (a switch, or an upgrade tip on an older API).
 */
export default function SessionDetailPage({ newView }: { newView?: NewViewLink }) {
  const { rootTaskId } = useParams<{ rootTaskId: string }>();
  const gate = useFeatureGate("1.76.0");
  const renameGate = useFeatureGate("1.120.0");
  const sharingGate = useFeatureGate(SESSION_SHARING_MIN_VERSION);
  const { data: detail, isLoading: detailLoading, error: detailError } = useSession(rootTaskId);
  const noAccess = sessionErrorStatus(detailError) === 403;
  // Only the owner shares, and only a session that has one (Slack and
  // schedule sessions are open to everyone already). Older servers omit
  // `access`/`owner`, so the button stays hidden there.
  const shareOwner =
    sharingGate.supported && !noAccess && detail?.access === "owner" && detail.owner
      ? detail.owner
      : null;
  const updateTitle = useUpdateSessionTitle();
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  const startEditingTitle = () => {
    setDraftTitle(detail?.root.title ?? "");
    setIsEditingTitle(true);
  };

  const saveTitle = () => {
    if (!detail) return;
    const trimmed = draftTitle.trim();
    setIsEditingTitle(false);
    if (trimmed === (detail.root.title ?? "")) return;
    updateTitle.mutate({ id: detail.root.id, title: trimmed || null });
  };

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
      <SessionsShell newView={newView}>
        <p className="text-muted-foreground p-3">Missing session id.</p>
      </SessionsShell>
    );
  }

  return (
    <SessionsShell activeRootTaskId={rootTaskId} newView={newView}>
      <SessionPresenceProvider rootTaskId={rootTaskId} enabled={!!detail}>
        {/* Editorial header — serif title + quiet meta caption. Single 72px
          band, no double divider. */}
        <header className="group flex flex-col gap-1 border-b border-border px-6 pt-4 pb-3 shrink-0 min-w-0 bg-background">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-1 min-w-0">
              {detailLoading ? (
                <Skeleton className="h-6 w-72" />
              ) : detail ? (
                isEditingTitle ? (
                  <Input
                    autoFocus
                    value={draftTitle}
                    placeholder={detail.root.task}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      } else if (e.key === "Escape") {
                        setIsEditingTitle(false);
                      }
                    }}
                    className="h-auto text-lg md:text-xl font-semibold leading-tight px-1.5 py-0"
                  />
                ) : (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <h1
                      className="text-lg md:text-xl font-semibold leading-tight text-foreground truncate"
                      title={sessionDisplayTitle(detail.root)}
                    >
                      {sessionDisplayTitle(detail.root)}
                    </h1>
                    {renameGate.supported ? (
                      <button
                        type="button"
                        onClick={startEditingTitle}
                        aria-label="Rename session"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  {noAccess ? "Private session" : "Session not found."}
                </p>
              )}
            </div>
            {detail ? (
              <div className="flex items-center gap-2 shrink-0">
                <SessionPresenceAvatars />
                {shareOwner ? (
                  <ShareSessionButton
                    rootTaskId={detail.root.id}
                    title={sessionDisplayTitle(detail.root)}
                    owner={shareOwner}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          {detail ? (
            <SessionMeta detail={detail}>
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
            </SessionMeta>
          ) : null}
        </header>

        <SessionConversation rootTaskId={rootTaskId} showInternalHandoffs={showInternalHandoffs} />
      </SessionPresenceProvider>
    </SessionsShell>
  );
}
