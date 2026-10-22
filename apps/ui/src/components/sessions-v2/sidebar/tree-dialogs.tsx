/**
 * The menus and dialogs of the sidebar tree: the row menu, the group menu,
 * "Pick a date and time", the move dialog, and the group delete confirm.
 * `useTreeDialogs` holds their state and the focus rule; `TreeDialogs`
 * renders them. On a phone the Later menu and the group menu are sheets
 * (`mobile/session-sheets.tsx`).
 */

import { useRef, useState } from "react";
import type { SessionListItem } from "@/api/types";
import type { GroupTarget } from "@/lib/session-groups";
import { NEW_SESSION_TAB } from "@/lib/sessions-v2";
import { sessionDisplayTitle } from "@/lib/utils";
import { GroupSheet, SnoozeSheet } from "../mobile/session-sheets";
import {
  DeleteGroupDialog,
  GroupMenu,
  type GroupMenuActions,
  type GroupMenuState,
} from "./group-menu";
import { type GroupPick, MoveToGroupDialog } from "./move-to-group-dialog";
import { useLastValue } from "./point-menu";
import { RowMenu, type RowMenuActions, type RowMenuState } from "./row-menu";
import { SnoozeDateDialog } from "./snooze-picker";
import type { TreeMoves } from "./use-tree-moves";

/**
 * The open menu or dialog of the tree, and what runs when a menu is gone.
 * By default the focus goes back to the list. A dialog opened from a menu
 * keeps the focus (`takeFocus`). A field or a composer opens only after the
 * menu is gone (`afterMenu`): the menu's focus trap would take the focus
 * back from it.
 */
export function useTreeDialogs(focusTree: () => void) {
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const [dateFor, setDateFor] = useState<SessionListItem[] | null>(null);
  const [pick, setPick] = useState<GroupPick | null>(null);
  const [deleting, setDeleting] = useState<{ key: string; open: boolean } | null>(null);
  const menuDone = useRef<(() => void) | null>(null);
  const menuOpen = menu !== null || groupMenu !== null;

  return {
    menu,
    setMenu,
    groupMenu,
    setGroupMenu,
    dateFor,
    pick,
    setPick,
    deleting,
    setDeleting,
    menuOpen,
    takeFocus: () => {
      if (menuOpen) menuDone.current = () => {};
    },
    afterMenu: (run: () => void) => {
      if (menuOpen) menuDone.current = run;
      else run();
    },
    onMenuClosed: () => {
      const run = menuDone.current;
      menuDone.current = null;
      if (run) run();
      else focusTree();
    },
    /** "Pick a date and time…" (it takes the focus from the closing menu). */
    pickDate: (sessions: SessionListItem[]) => {
      if (menuOpen) menuDone.current = () => {};
      setDateFor(sessions);
    },
    closeDate: () => setDateFor(null),
  };
}

export type TreeDialogState = ReturnType<typeof useTreeDialogs>;

export function TreeDialogs({
  dialogs,
  focused,
  canTriage,
  triage,
  groupActions,
  targets,
  writeBlock,
  moves,
  newSession,
  focusTree,
  phone = false,
}: {
  dialogs: TreeDialogState;
  /** The focused tab: a pick into a New session tab that is open already keeps the list focus. */
  focused: string;
  canTriage: boolean;
  triage: RowMenuActions;
  groupActions: GroupMenuActions;
  targets: GroupTarget[];
  writeBlock: (key: string) => string | null;
  moves: TreeMoves;
  newSession: (group: string | null) => void;
  focusTree: () => void;
  /** Sheets for the Later menu and the group menu. */
  phone?: boolean;
}) {
  // A pick into a New session tab that was open already mounts no composer,
  // so nothing takes the focus: the list gets it back.
  const newTabWasOpen = useRef(false);
  const startNew = (key: string | null) => {
    newTabWasOpen.current = focused === NEW_SESSION_TAB;
    newSession(key);
  };
  const { deleting, dateFor } = dialogs;
  // The sheet keeps its words while it slides out.
  const later = useLastValue(phone ? dialogs.menu : null);
  const [laterOnly] = later?.targets ?? [];

  return (
    <>
      {phone ? (
        <SnoozeSheet
          open={dialogs.menu !== null}
          onOpenChange={(open) => !open && dialogs.setMenu(null)}
          what={
            later?.targets.length === 1 && laterOnly
              ? sessionDisplayTitle(laterOnly.root)
              : `${later?.targets.length ?? 0} sessions`
          }
          onSnooze={(at) => later && triage.later(later.targets, at)}
          onPickDate={() => later && triage.pickDate(later.targets)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            dialogs.onMenuClosed();
          }}
        />
      ) : (
        <RowMenu
          state={dialogs.menu}
          actions={triage}
          canTriage={canTriage}
          onClose={() => dialogs.setMenu(null)}
          onRestoreFocus={dialogs.onMenuClosed}
        />
      )}
      {phone ? (
        <GroupSheet
          state={dialogs.groupMenu}
          actions={groupActions}
          onClose={() => dialogs.setGroupMenu(null)}
          onRestoreFocus={dialogs.onMenuClosed}
        />
      ) : (
        <GroupMenu
          state={dialogs.groupMenu}
          actions={groupActions}
          onClose={() => dialogs.setGroupMenu(null)}
          onRestoreFocus={dialogs.onMenuClosed}
        />
      )}
      <SnoozeDateDialog
        open={dateFor !== null}
        onOpenChange={(open) => {
          if (!open) dialogs.closeDate();
        }}
        onSnooze={(at) => {
          if (dateFor) triage.later(dateFor, at);
          dialogs.closeDate();
        }}
        onRestoreFocus={focusTree}
      />
      <MoveToGroupDialog
        pick={dialogs.pick}
        targets={targets}
        writeBlock={writeBlock}
        onClose={() => dialogs.setPick(null)}
        onPickGroup={(current, key) => {
          if (current.purpose === "move") void moves.move(current.sessions, key);
          else startNew(key);
        }}
        onCreateGroup={(current, name) => {
          const made = moves.create("shared/", name);
          if (!made) return;
          if (current.purpose === "move") void moves.move(current.sessions, made.key);
          else startNew(made.key);
        }}
        onRestoreFocus={(current, picked) => {
          // A move from the pane header goes back there. A new tab focuses its
          // composer itself. Every other close gives the list the focus.
          if (current.purpose === "move" && current.returnFocus) current.returnFocus();
          else if (current.purpose === "move" || !picked || newTabWasOpen.current) focusTree();
        }}
      />
      <DeleteGroupDialog
        label={deleting ? moves.labelOf(deleting.key) : ""}
        open={deleting?.open ?? false}
        onOpenChange={(open) => {
          if (!open) dialogs.setDeleting((prev) => (prev ? { ...prev, open: false } : prev));
        }}
        onConfirm={() => {
          if (deleting) void moves.remove(deleting.key);
        }}
        onRestoreFocus={focusTree}
      />
    </>
  );
}
