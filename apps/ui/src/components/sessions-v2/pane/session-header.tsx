/**
 * The session pane header (SPEC R8.1, R8.2, R9, R10.3), two rows:
 *
 * - Row 1: the crumb (the group path, a button that shows the group in the
 *   sidebar) and "Shared by Lena · can view" on the left. The people here
 *   now, the People pill, the triage buttons, and the owner's Share icon on
 *   the right.
 * - Row 2: the title (`SessionTitle`: an ellipsis, inline rename) on the
 *   left, the meta line (`SessionMetaLine`) on the right.
 */

import { Hash, SquareDashed } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useInboxState } from "@/api/hooks/use-inbox-state";
import { useSessionShares } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionDetailResponse, SessionListItem } from "@/api/types";
import { SessionPresenceAvatars } from "@/components/sessions/session-presence";
import { ShareSessionButton } from "@/components/sessions/share-session-dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import { groupCrumb, groupKeyOf, isNoGroupKey } from "@/lib/session-groups";
import { itemFromDetail, userName } from "@/lib/sessions-v2";
import { cn, sessionDisplayTitle } from "@/lib/utils";
import { PeoplePill } from "./people-pill";
import { focusQuietly } from "./quiet-focus";
import { SessionMetaLine } from "./session-meta-line";
import { SessionTitle } from "./session-title";
import { TriageButtons } from "./triage-buttons";

const HEADER = "shrink-0 border-b border-border py-2.5 pr-4 pl-5";
const ROW_1 = "flex min-h-7 min-w-0 items-center gap-2";
const ROW_2 = "mt-1 flex min-h-8 min-w-0 items-center gap-4";

/** The header while the session loads, at the same height. */
export function SessionHeaderSkeleton() {
  return (
    <div aria-hidden className={HEADER}>
      <div className={ROW_1}>
        <Skeleton className="h-3 w-40" />
      </div>
      <div className={ROW_2}>
        <Skeleton className="h-5 w-80" />
      </div>
    </div>
  );
}

/** Row 1 left: the group path. A click shows the group in the sidebar. */
function GroupCrumb({
  groupKey,
  me,
  onReveal,
}: {
  groupKey: string | undefined;
  me: string | null;
  /** Show the group in the sidebar tree (null: No group). */
  onReveal: (groupKey: string | null) => void;
}) {
  const { data: users } = useUsers();
  const noGroup = !groupKey || isNoGroupKey(groupKey, me);
  const GroupIcon = noGroup ? SquareDashed : Hash;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onReveal(noGroup ? null : groupKey)}
          className="-ml-1.5 min-w-0 shrink justify-start font-normal text-muted-foreground hover:text-foreground"
        >
          <GroupIcon aria-hidden className="shrink-0" />
          <span className="truncate">{groupCrumb(groupKey, me, (id) => userName(users, id))}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Show this group in the sidebar</TooltipContent>
    </Tooltip>
  );
}

/**
 * The open session as a list row, for the triage buttons and the meta line.
 * The detail has no Later wake time: it comes from the snoozed rows.
 */
export function useSessionItem(detail: SessionDetailResponse): SessionListItem {
  const { userId } = useCurrentUser();
  const inLater = detail.readState === "later";
  const snoozed = useInboxState({
    userId: inLater ? userId : null,
    status: "snoozed",
    itemType: "to_read",
  });
  const wake = inLater
    ? (snoozed.data?.find((row) => row.itemId === detail.root.id)?.snoozeUntil ?? null)
    : null;
  return useMemo(() => itemFromDetail(detail, wake), [detail, wake]);
}

export function SessionHeader({
  detail,
  showHandoffs,
  onShowHandoffs,
  renaming,
  onRenamingChange,
  onMove,
  onRevealGroup,
  keysActive = true,
}: {
  detail: SessionDetailResponse;
  showHandoffs: boolean;
  onShowHandoffs: (on: boolean) => void;
  /** The title is the rename field (the pencil, a double-click, or Cmd+K "Rename session"). */
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  /** Opens the sidebar's move dialog. `returnFocus` runs when it closes. */
  onMove: (sessions: SessionListItem[], returnFocus: () => void) => void;
  /** Shows a group in the sidebar tree (null: No group). */
  onRevealGroup: (groupKey: string | null) => void;
  /** The triage keys act on this header (the active pane of a split). */
  keysActive?: boolean;
}) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  const [shareOpen, setShareOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  // "Share…" in the People popover opened the dialog: its close goes back to the pill.
  const shareFromPill = useRef(false);
  const session = useSessionItem(detail);

  const { owner, access } = detail;
  const sharedBy =
    owner && owner.id !== me && (access === "read" || access === "write")
      ? `Shared by ${owner.name} · ${access === "write" ? "can edit" : "can view"}`
      : null;
  const shareOwner = access === "owner" && owner ? owner : null;
  // The Share icon (and its divider) shows once the server answers that it shares.
  const shares = useSessionShares(detail.root.id, shareOwner !== null);

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      <header className={cn("group/header", HEADER)}>
        <div className={ROW_1}>
          <GroupCrumb
            groupKey={detail.root.key ? groupKeyOf(detail.root.key) : undefined}
            me={me}
            onReveal={onRevealGroup}
          />
          {sharedBy ? (
            <p className="min-w-0 shrink truncate text-xs text-muted-foreground before:mr-2 before:content-['·']">
              {sharedBy}
            </p>
          ) : null}
          <span className="min-w-0 flex-1" />
          <div className="flex shrink-0 items-center gap-1.5">
            <SessionPresenceAvatars />
            <PeoplePill
              ref={pillRef}
              detail={detail}
              onShare={
                shareOwner
                  ? () => {
                      shareFromPill.current = true;
                      setShareOpen(true);
                    }
                  : undefined
              }
            />
            <TriageButtons session={session} onMove={onMove} keysActive={keysActive} />
            {shareOwner && shares.data ? (
              <>
                <Separator
                  orientation="vertical"
                  className="mx-0.5 data-[orientation=vertical]:h-4"
                />
                <ShareSessionButton
                  icon
                  rootTaskId={detail.root.id}
                  title={sessionDisplayTitle(detail.root)}
                  owner={shareOwner}
                  open={shareOpen}
                  onOpenChange={setShareOpen}
                  onCloseAutoFocus={(event) => {
                    if (!shareFromPill.current) return;
                    shareFromPill.current = false;
                    event.preventDefault();
                    focusQuietly(pillRef.current);
                  }}
                />
              </>
            ) : null}
          </div>
        </div>
        <div className={ROW_2}>
          <div className="flex min-w-[min(55%,22rem)] flex-1 basis-0 items-center gap-0.5">
            <SessionTitle
              detail={detail}
              // The owner and Can edit rename (SPEC R8.2). An older server sends no access: full access.
              canRename={access !== "read"}
              renaming={renaming}
              onRenamingChange={onRenamingChange}
            />
          </div>
          <SessionMetaLine
            detail={detail}
            session={session}
            showHandoffs={showHandoffs}
            onShowHandoffs={onShowHandoffs}
          />
        </div>
      </header>
    </TooltipProvider>
  );
}
