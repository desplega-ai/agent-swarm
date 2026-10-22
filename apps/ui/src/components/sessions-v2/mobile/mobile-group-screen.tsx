/**
 * "View all N" on a phone (SPEC R8.5): the group tab's content at full
 * width (its search, filter, pager, and `MobileList`) under a back chevron.
 * The rows are the list screen's touch rows (one line titles, swipe,
 * long-press), with the same selection bars and Later sheet. A session
 * opened here pushes over it, and back returns to it.
 */

import { useId, useMemo, useRef, useState } from "react";
import type { SessionListItem } from "@/api/types";
import { MobileList } from "@/components/shared/mobile-list";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useStableHandler } from "@/hooks/use-stable-handler";
import type { SwipeSide } from "@/hooks/use-swipe-row";
import { sessionDisplayTitle } from "@/lib/utils";
import { GroupTab } from "../group-tab";
import { useLastValue } from "../sidebar/point-menu";
import { useMinuteClock } from "../sidebar/session-tree";
import { SnoozeDateDialog } from "../sidebar/snooze-picker";
import type { TreeRow } from "../sidebar/tree-rows";
import { useSessionSelection } from "../sidebar/use-session-selection";
import { useSessionTriageActions } from "../use-session-triage-actions";
import { MobileBulkBar } from "./mobile-bulk-bar";
import { MobileTopBar } from "./mobile-top-bar";
import { MobileSessionRow } from "./mobile-tree-row";
import { SnoozeSheet } from "./session-sheets";

type Move = (sessions: SessionListItem[], returnFocus: () => void) => void;

export function MobileGroupScreen({
  view,
  covered,
  onBack,
  onOpen,
  onMove,
}: {
  /** The list (`?view=`): a section or a group key. */
  view: string;
  /** A session screen lies over this one. */
  covered: boolean;
  onBack: () => void;
  onOpen: (rootTaskId: string) => void;
  /** The list screen's move sheet. */
  onMove: Move;
}) {
  const backRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      inert={covered}
      aria-hidden={covered || undefined}
      data-phone-screen="group"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <MobileTopBar
        onBack={onBack}
        backLabel="Back to sessions"
        backRef={backRef}
        className="border-b-0"
      >
        <span className="truncate text-base font-medium text-muted-foreground">Sessions</span>
      </MobileTopBar>
      <GroupTab
        view={view}
        onOpen={onOpen}
        // One page scrolls: the search, the filter, the rows, then the pager.
        className="overflow-y-auto overscroll-contain px-4 pt-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        phoneList={(rows, { loading, label }) => (
          <GroupRows
            rows={rows}
            loading={loading}
            label={label}
            view={view}
            onOpen={onOpen}
            // After a move the selection is gone: the focus goes to the back button.
            onMove={(sessions) => onMove(sessions, () => backRef.current?.focus())}
          />
        )}
      />
    </div>
  );
}

/** The page's sessions as touch rows, with the selection and the Later sheet. */
function GroupRows({
  rows,
  loading,
  label,
  view,
  onOpen,
  onMove,
}: {
  rows: SessionListItem[] | undefined;
  loading: boolean;
  label: string;
  view: string;
  onOpen: (rootTaskId: string) => void;
  onMove: (sessions: SessionListItem[]) => void;
}) {
  const { userId } = useCurrentUser();
  const me = userId ?? null;
  const now = useMinuteClock();
  const baseId = useId();
  // The selection keeps only rows on this page (`useSessionSelection` over the same row model).
  const treeRows = useMemo(
    (): TreeRow[] =>
      (rows ?? []).map((session) => ({
        type: "session",
        key: session.root.id,
        level: 0,
        container: view,
        session,
        flat: true,
      })),
    [rows, view],
  );
  const byId = useMemo(
    () => new Map((rows ?? []).map((session) => [session.root.id, session])),
    [rows],
  );
  const selection = useSessionSelection(treeRows);
  const [laterFor, setLaterFor] = useState<SessionListItem[] | null>(null);
  const [dateFor, setDateFor] = useState<SessionListItem[] | null>(null);
  const later = useLastValue(laterFor);
  const triage = useSessionTriageActions({
    clearSelection: selection.clear,
    pickDate: setDateFor,
    pickGroup: onMove,
  });

  const onTap = useStableHandler((id: string) => {
    if (selection.selectionMode) selection.toggle(id);
    else onOpen(id);
  });
  const onSwipe = useStableHandler((id: string, side: SwipeSide) => {
    const session = byId.get(id);
    if (!session) return;
    if (side === "left") triage.doneOrBack([session]);
    else triage.laterOrBack([session], () => setLaterFor([session]));
  });
  const onLongPress = useStableHandler((id: string) => {
    if (!selection.selected.has(id)) selection.toggle(id);
  });
  const selected = selection.selectionMode ? selection.sessions() : [];
  const [laterOnly] = later ?? [];

  return (
    <>
      <MobileList
        label={label}
        loading={loading}
        emptyMessage="No sessions match."
        // The rows run edge to edge like the list screen's, with no box and
        // no scroll of their own: the screen scrolls, and the pager follows them.
        className={
          rows?.length
            ? "-mx-4 flex-none overflow-visible rounded-none border-x-0 border-t border-b border-border-subtle bg-transparent"
            : undefined
        }
      >
        {(rows ?? []).map((session) => (
          <MobileSessionRow
            key={session.root.id}
            as="list"
            rowKey={session.root.id}
            session={session}
            domId={`${baseId}${session.root.id}`}
            level={0}
            flat
            me={me}
            now={now}
            selected={selection.selected.has(session.root.id)}
            selecting={selection.selectionMode}
            canTriage={triage.canTriage}
            onRowClick={onTap}
            onSwipe={onSwipe}
            onLongPress={onLongPress}
          />
        ))}
      </MobileList>
      <MobileBulkBar
        open={selected.length > 0}
        count={selected.length}
        canTriage={triage.canTriage}
        anyUnread={selected.some((session) => session.readState === "unread")}
        onDone={() => triage.actions.done(selected)}
        onLater={() => setLaterFor(selected)}
        onToggleRead={() => triage.actions.toggleRead(selected)}
        onMove={() => triage.actions.move(selected)}
        onClear={selection.clear}
      />
      <SnoozeSheet
        open={laterFor !== null}
        onOpenChange={(open) => !open && setLaterFor(null)}
        what={
          later?.length === 1 && laterOnly
            ? sessionDisplayTitle(laterOnly.root)
            : `${later?.length ?? 0} sessions`
        }
        onSnooze={(at) => later && triage.actions.later(later, at)}
        onPickDate={() => later && triage.actions.pickDate(later)}
      />
      <SnoozeDateDialog
        open={dateFor !== null}
        onOpenChange={(open) => !open && setDateFor(null)}
        onSnooze={(at) => {
          if (dateFor) triage.actions.later(dateFor, at);
          setDateFor(null);
        }}
        onRestoreFocus={() => {}}
      />
    </>
  );
}
