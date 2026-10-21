import { useEffect, useRef } from "react";
import { useSessionTriage } from "@/api/hooks/use-session-triage";
import type { SessionDetailResponse } from "@/api/types";

/**
 * Opening a session marks it read, from wherever it opened (a sidebar row,
 * `?view=`, a link, a notification, `?tabs=`). It reads the session detail,
 * which carries the viewer's read state with the list's rule.
 *
 * Only an unread session gets the mark (the app's `shouldMarkRead`): the
 * write sets `status: "open"`, which would end Done or Later. Once per open
 * and per activity: "Mark unread" on the open session stays, and new
 * activity while it is open marks it read again. The pane remounts for
 * each session, so each open starts fresh.
 */
export function useMarkReadOnOpen(detail: SessionDetailResponse | undefined) {
  const { canTriage, markRead } = useSessionTriage();
  // The activity this open has seen. Seen activity never marks twice.
  const seen = useRef<string | null>(null);
  const rootId = detail?.root.id;
  const readState = detail?.readState;
  const lastActivityAt = detail?.lastActivityAt;

  useEffect(() => {
    if (!canTriage || !rootId || !readState || !lastActivityAt) return;
    if (seen.current === lastActivityAt) return;
    seen.current = lastActivityAt;
    if (readState === "unread") markRead({ rootId, lastActivityAt });
  }, [canTriage, rootId, readState, lastActivityAt, markRead]);
}
