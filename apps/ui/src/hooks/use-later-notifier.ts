import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { SESSION_TREE_KEY } from "@/api/hooks/use-session-tree";
import { useSessions } from "@/api/hooks/use-sessions";
import type { SessionListItem } from "@/api/types";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  SESSIONS_TOAST_POSITION,
  SESSIONS_V2_MIN_VERSION,
  sidebarListParams,
} from "@/lib/sessions-v2";
import { sessionDisplayTitle } from "@/lib/utils";

/** `setTimeout` takes at most 2^31 - 1 ms. A later wake re-arms after a day. */
const MAX_WAIT_MS = 86_400_000;

let askedThisLoad = false;

/**
 * Ask once for browser notifications, on the first Later of this page load
 * (SPEC R4). A refusal keeps the in-page toast.
 */
export function askNotifyPermission(): void {
  if (askedThisLoad || typeof Notification === "undefined") return;
  askedThisLoad = true;
  if (Notification.permission !== "default") return;
  Notification.requestPermission().catch(() => {
    // An old browser or an insecure origin: the toast still shows.
  });
}

/** Whether the browser will show a notification now. */
export function notificationsBlocked(): boolean {
  return typeof Notification === "undefined" || Notification.permission === "denied";
}

const wakeKey = (row: SessionListItem) => `${row.root.id}:${row.snoozeUntil}`;

/** A toast keeps a title short (SPEC R10.3): one line, with an ellipsis. */
function clipTitle(title: string, max = 48): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

/**
 * Later wakes up in this browser while the dashboard is open (plan A13: no
 * server job). It reads the Later list (sorted by wake time, the same cache
 * entry as the sidebar's Later list) and sets one timer for the next wake.
 * Then it shows a browser notification (when allowed) and a toast, and
 * refetches the tree and the lists: the server already counts the session
 * as unread in the Inbox.
 */
export function useLaterNotifier(): void {
  const { userId } = useCurrentUser();
  const gate = useFeatureGate(SESSIONS_V2_MIN_VERSION);
  const later = useSessions({ ...sidebarListParams("later"), enabled: gate.supported && !!userId });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  });
  // One alert per wake, also when the list holds the row for one more render.
  const notified = useRef(new Set<string>());
  // Re-runs the check when a timer ends.
  const [tick, setTick] = useState(0);
  const rows = later.data?.sessions;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-runs the check when a timer ends
  useEffect(() => {
    if (!rows?.length) return;
    const now = Date.now();
    const due = rows.filter(
      (row) =>
        row.snoozeUntil &&
        Date.parse(row.snoozeUntil) <= now &&
        !notified.current.has(wakeKey(row)),
    );
    if (due.length > 0) {
      for (const row of due) notified.current.add(wakeKey(row));
      alertWake(due, (id) => navigateRef.current(`/sessions/${encodeURIComponent(id)}`));
      void queryClient.invalidateQueries({ queryKey: SESSION_TREE_KEY });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
    const next = rows
      .map((row) => (row.snoozeUntil ? Date.parse(row.snoozeUntil) : Number.NaN))
      .filter((at) => at > now)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), Math.min(next - now, MAX_WAIT_MS));
    return () => window.clearTimeout(timer);
  }, [rows, tick, queryClient]);
}

function alertWake(rows: SessionListItem[], open: (id: string) => void): void {
  const first = rows[0];
  const title = sessionDisplayTitle(first.root);
  const message =
    rows.length === 1
      ? `"${clipTitle(title)}" is back in your Inbox.`
      : `${rows.length} sessions are back in your Inbox.`;
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      const notification = new Notification("Back from Later", {
        body: rows.length === 1 ? title : message,
        tag: `sessions-wake-${first.root.id}`,
      });
      notification.onclick = () => {
        window.focus();
        open(first.root.id);
        notification.close();
      };
    } catch {
      // Some browsers notify only from a service worker. The toast still shows.
    }
  }
  toast(message, {
    position: SESSIONS_TOAST_POSITION,
    duration: 8000,
    action: { label: "Open", onClick: () => open(first.root.id) },
  });
}
