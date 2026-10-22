import { toast } from "sonner";
import { type TriageTarget, useSessionTriage } from "@/api/hooks/use-session-triage";
import type { SessionListItem } from "@/api/types";
import { askNotifyPermission, notificationsBlocked } from "@/hooks/use-later-notifier";
import { SESSIONS_TOAST_POSITION } from "@/lib/sessions-v2";
import type { RowMenuActions } from "./sidebar/row-menu";
import { wakePhrase } from "./sidebar/snooze-times";

/** An Undo toast stays long enough to reach (UX review R9 P0). */
const UNDO_TOAST_MS = 5200;

const targetOf = (session: SessionListItem): TriageTarget => ({
  rootId: session.root.id,
  lastActivityAt: session.lastActivityAt,
});

const whatOf = (sessions: SessionListItem[]) =>
  sessions.length === 1 ? "Session" : `${sessions.length} sessions`;

/** The triage part of the row menu: what the sidebar and the pane header share. */
type TriageActions = Omit<RowMenuActions, "open" | "openNewTab" | "openInSplit">;

/**
 * Triage from the sidebar (the row menu, the keys) and the pane header:
 * read, Done, Later, and back to the Inbox, with an Undo toast when a
 * session leaves its list. Undo puts each session back the way it was.
 */
export function useSessionTriageActions({
  clearSelection,
  pickDate,
  pickGroup,
}: {
  /** The sidebar selection ends after a triage action. The pane header has none. */
  clearSelection?: () => void;
  /** "Pick a date and time…": open the date dialog for these sessions. */
  pickDate: (sessions: SessionListItem[]) => void;
  /** "Move to group…": open the move dialog for these sessions. */
  pickGroup: (sessions: SessionListItem[]) => void;
}) {
  const triage = useSessionTriage();

  const restore = (sessions: SessionListItem[]) => {
    const by = (state: SessionListItem["readState"]) =>
      sessions.filter((s) => s.readState === state).map(targetOf);
    triage.markUnread(by("unread"));
    triage.done(by("done"));
    // Read, or no read state: back in the Inbox, and the server's rule reads it as read.
    triage.backToInbox(
      sessions
        .filter(
          (s) => s.readState !== "unread" && s.readState !== "done" && s.readState !== "later",
        )
        .map(targetOf),
    );
    for (const session of sessions) {
      if (session.readState === "later" && session.snoozeUntil) {
        triage.later(targetOf(session), session.snoozeUntil);
      }
    }
  };
  const undoToast = (message: string, sessions: SessionListItem[]) =>
    toast(message, {
      position: SESSIONS_TOAST_POSITION,
      duration: UNDO_TOAST_MS,
      action: { label: "Undo", onClick: () => restore(sessions) },
    });

  const actions: TriageActions = {
    toggleRead: (sessions) => {
      if (sessions.some((s) => s.readState === "unread")) triage.markRead(sessions.map(targetOf));
      else triage.markUnread(sessions.map(targetOf));
      clearSelection?.();
    },
    done: (sessions) => {
      triage.done(sessions.map(targetOf));
      clearSelection?.();
      undoToast(`${whatOf(sessions)} marked Done.`, sessions);
    },
    later: (sessions, at) => {
      askNotifyPermission();
      triage.later(sessions.map(targetOf), at);
      clearSelection?.();
      const fallback = notificationsBlocked()
        ? " Browser notifications are off, so the alert shows here."
        : "";
      undoToast(
        `${whatOf(sessions)} snoozed. Back in your Inbox ${wakePhrase(at, new Date())}.${fallback}`,
        sessions,
      );
    },
    backToInbox: (sessions) => {
      triage.backToInbox(sessions.map(targetOf));
      clearSelection?.();
      undoToast(`${whatOf(sessions)} moved back to the Inbox.`, sessions);
    },
    pickDate,
    move: pickGroup,
  };

  /** Done, or back to the Inbox when every session is in Done already (the `e` toggle). */
  const doneOrBack = (sessions: SessionListItem[]) => {
    if (sessions.length === 0) return;
    if (sessions.every((s) => s.readState === "done")) actions.backToInbox(sessions);
    else actions.done(sessions);
  };
  /** Back to the Inbox when every session is in Later already, else `pick` a wake time (the `l` toggle). */
  const laterOrBack = (sessions: SessionListItem[], pick: () => void) => {
    if (sessions.length === 0) return;
    if (sessions.every((s) => s.readState === "later")) actions.backToInbox(sessions);
    else pick();
  };

  return { canTriage: triage.canTriage, actions, doneOrBack, laterOrBack };
}
