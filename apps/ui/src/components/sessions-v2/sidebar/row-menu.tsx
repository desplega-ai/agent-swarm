/**
 * The session row menu. Right-click and the menu key open it at the row;
 * `l` opens its Later part alone (sessions already in Later go straight
 * back to the Inbox, with no menu). It opens at a point (`PointMenu`, plan
 * Phase 4). "Move to group…" opens the move dialog (Phase 5). "Open in
 * split" opens the row in the split pane (Phase 8).
 */

import {
  AlarmClock,
  AppWindow,
  Archive,
  Columns2,
  CornerDownLeft,
  FolderInput,
  Inbox,
  Mail,
  MailOpen,
} from "lucide-react";
import type { SessionListItem } from "@/api/types";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuKey, PointMenu } from "./point-menu";
import { SnoozeMenuItems } from "./snooze-picker";

export interface RowMenuState {
  /** Viewport point the menu opens at. */
  x: number;
  y: number;
  /** `row`: the full menu. `later`: the Later choices only (the `l` key). */
  kind: "row" | "later";
  /** The row the menu belongs to: Open and Open in new tab act on it. */
  session: SessionListItem;
  /** What triage acts on: the selection when the row is in it, else the row. */
  targets: SessionListItem[];
}

export interface RowMenuActions {
  open: (session: SessionListItem) => void;
  openNewTab: (session: SessionListItem) => void;
  openInSplit: (session: SessionListItem) => void;
  toggleRead: (targets: SessionListItem[]) => void;
  done: (targets: SessionListItem[]) => void;
  later: (targets: SessionListItem[], at: string) => void;
  backToInbox: (targets: SessionListItem[]) => void;
  pickDate: (targets: SessionListItem[]) => void;
  /** Open the move dialog for these sessions. */
  move: (targets: SessionListItem[]) => void;
}

export function RowMenu({
  state,
  actions,
  canTriage,
  onClose,
  onRestoreFocus,
}: {
  state: RowMenuState | null;
  actions: RowMenuActions;
  /** Read, Done, and Later need a picked user. Moves do not. */
  canTriage: boolean;
  onClose: () => void;
  /** Focus goes back to the list when the menu closes. */
  onRestoreFocus: () => void;
}) {
  return (
    <PointMenu state={state} onClose={onClose} onRestoreFocus={onRestoreFocus} className="min-w-56">
      {(shown) => <RowMenuItems shown={shown} actions={actions} canTriage={canTriage} />}
    </PointMenu>
  );
}

function RowMenuItems({
  shown,
  actions,
  canTriage,
}: {
  shown: RowMenuState;
  actions: RowMenuActions;
  canTriage: boolean;
}) {
  const { targets, session } = shown;
  const allDone = targets.every((row) => row.readState === "done");
  const allLater = targets.every((row) => row.readState === "later");
  const anyUnread = targets.some((row) => row.readState === "unread");

  return (
    <>
      {shown.kind === "later" ? (
        <SnoozeMenuItems
          onSnooze={(at) => actions.later(targets, at)}
          onPickDate={() => actions.pickDate(targets)}
        />
      ) : (
        <>
          <DropdownMenuItem onSelect={() => actions.open(session)}>
            <CornerDownLeft />
            Open
            <MenuKey>↵</MenuKey>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.openNewTab(session)}>
            <AppWindow />
            Open in new tab
            <MenuKey>T</MenuKey>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.openInSplit(session)}>
            <Columns2 />
            Open in split
            <MenuKey>V</MenuKey>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {canTriage ? (
            <>
              <DropdownMenuItem onSelect={() => actions.toggleRead(targets)}>
                {anyUnread ? <MailOpen /> : <Mail />}
                {anyUnread ? "Mark read" : "Mark unread"}
                <MenuKey>U</MenuKey>
              </DropdownMenuItem>
              {allDone ? (
                <DropdownMenuItem onSelect={() => actions.backToInbox(targets)}>
                  <Inbox />
                  Move back to the Inbox
                  <MenuKey>E</MenuKey>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => actions.done(targets)}>
                  <Archive />
                  Done
                  <MenuKey>E</MenuKey>
                </DropdownMenuItem>
              )}
              {allLater ? (
                <DropdownMenuItem onSelect={() => actions.backToInbox(targets)}>
                  <Inbox />
                  Move back to the Inbox
                  <MenuKey>L</MenuKey>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <AlarmClock />
                    Later…
                    <MenuKey>L</MenuKey>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-60">
                    <SnoozeMenuItems
                      onSnooze={(at) => actions.later(targets, at)}
                      onPickDate={() => actions.pickDate(targets)}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </>
          ) : null}
          <DropdownMenuItem onSelect={() => actions.move(targets)}>
            <FolderInput />
            Move to group…
            <MenuKey>M</MenuKey>
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
