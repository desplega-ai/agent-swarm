import { useEffect, useRef } from "react";
import { useSessionTriage } from "@/api/hooks/use-session-triage";
import type { SessionDetailResponse } from "@/api/types";
import { useCurrentUser } from "@/contexts/current-user-context";

/**
 * Opening a session marks it read, from wherever it opened (a sidebar row,
 * `?view=`, a link, a notification, `?tabs=`). It reads the session detail,
 * which carries the viewer's read state with the list's rule.
 *
 * Only an unread session gets the mark (the app's `shouldMarkRead`): the
 * write sets `status: "open"`, which would end Done or Later. Once per
 * user, session, and activity: "Mark unread" on the open session stays, new
 * activity while it is open marks it read again, and so does a switch to
 * another dashboard user (the pane does not remount for that).
 */
export function useMarkReadOnOpen(detail: SessionDetailResponse | undefined) {
  const { canTriage, markRead } = useSessionTriage();
  const { userId } = useCurrentUser();
  // The user, session, and activity this open has seen. Seen never marks twice.
  const seen = useRef<string | null>(null);
  const rootId = detail?.root.id;
  const readState = detail?.readState;
  const lastActivityAt = detail?.lastActivityAt;

  useEffect(() => {
    if (!canTriage || !userId || !rootId || !readState || !lastActivityAt) return;
    const key = `${userId} ${rootId} ${lastActivityAt}`;
    if (seen.current === key) return;
    seen.current = key;
    if (readState === "unread") markRead({ rootId, lastActivityAt });
  }, [canTriage, userId, rootId, readState, lastActivityAt, markRead]);
}
