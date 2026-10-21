import { sessionErrorStatus, useSession } from "@/api/hooks/use-sessions";
import type { SessionListItem } from "@/api/types";
import { SessionConversation } from "@/components/sessions/session-conversation";
import { SessionPresenceProvider } from "@/components/sessions/session-presence";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { SessionHeader, SessionHeaderSkeleton } from "./session-header";
import { useMarkReadOnOpen } from "./use-mark-read-on-open";

/**
 * The focused session in the v2 pane: the two-row header, then the
 * conversation with the turn timeline, the composer, and presence. The pane
 * is a size container: the header's meta line drops items when the pane is
 * narrow.
 */
export function SessionPane({
  rootTaskId,
  renaming,
  onRenamingChange,
  onMove,
  onRevealGroup,
  keysActive = true,
}: {
  rootTaskId: string;
  /** The header title is the rename field. */
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  /** Opens the sidebar's move dialog. `returnFocus` runs when it closes. */
  onMove: (sessions: SessionListItem[], returnFocus: () => void) => void;
  /** Shows a group in the sidebar tree (null: No group). */
  onRevealGroup: (groupKey: string | null) => void;
  /** The pane keys (`e`, `l`, `u`, `m`) act here: the active pane of a split. */
  keysActive?: boolean;
}) {
  // The conversation below polls this session: the header reads the same cache with no timer.
  const { data: detail, isLoading, error } = useSession(rootTaskId, { poll: "off" });
  useMarkReadOnOpen(detail);
  // The legacy header's toggle too, so both views show the same timeline.
  const [showInternalHandoffs, setShowInternalHandoffs] = useLocalToggle(
    "sessions:show-internal-handoffs",
    false,
  );
  // A 403 wins over cached data, as in the conversation below.
  const noAccess = sessionErrorStatus(error) === 403;
  return (
    // Off until the session loads, so a viewer with no access never asks for a ticket.
    <SessionPresenceProvider rootTaskId={rootTaskId} enabled={!!detail}>
      <div className="@container/pane flex min-h-0 flex-1 flex-col">
        {detail && !noAccess ? (
          <SessionHeader
            detail={detail}
            showHandoffs={showInternalHandoffs}
            onShowHandoffs={setShowInternalHandoffs}
            renaming={renaming}
            onRenamingChange={onRenamingChange}
            onMove={onMove}
            onRevealGroup={onRevealGroup}
            keysActive={keysActive}
          />
        ) : isLoading ? (
          <SessionHeaderSkeleton />
        ) : null}
        <SessionConversation
          rootTaskId={rootTaskId}
          showInternalHandoffs={showInternalHandoffs}
          timeline="turns"
        />
      </div>
    </SessionPresenceProvider>
  );
}
