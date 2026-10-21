/**
 * The group menu (plan Phase 5): New session here, New subgroup, Rename
 * group, Delete group. The "⋯" on a group row, a right-click, and the menu
 * key open it at the row. Groups under Shared with me have none. A group
 * this connection cannot write into (a personal group on the operator key)
 * keeps only Delete, which works there. Delete asks first.
 */

import { FolderPlus, type LucideIcon, Pencil, Plus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { MenuKey, PointMenu } from "./point-menu";

export interface GroupMenuState {
  /** Viewport point the menu opens at. */
  x: number;
  y: number;
  groupKey: string;
  /** The group's path, for the menu label. */
  label: string;
  /** Why this connection cannot write into the group, or null. */
  writeBlock: string | null;
}

export interface GroupMenuActions {
  newSession: (groupKey: string) => void;
  newSubgroup: (groupKey: string) => void;
  rename: (groupKey: string) => void;
  remove: (groupKey: string) => void;
}

interface GroupMenuItem {
  label: string;
  icon: LucideIcon;
  /** The desktop menu's key hint. */
  shortcut?: string;
  disabled: boolean;
  run: () => void;
}

/**
 * The group menu's items, for the desktop menu and the phone sheet: the
 * edits (off where this connection cannot write), then Delete, which works
 * everywhere.
 */
export function groupMenuItems(
  { groupKey, writeBlock }: Pick<GroupMenuState, "groupKey" | "writeBlock">,
  actions: GroupMenuActions,
): { edits: GroupMenuItem[]; remove: GroupMenuItem } {
  const blocked = writeBlock !== null;
  return {
    edits: [
      {
        label: "New session here",
        icon: Plus,
        shortcut: "C",
        disabled: blocked,
        run: () => actions.newSession(groupKey),
      },
      {
        label: "New subgroup",
        icon: FolderPlus,
        disabled: blocked,
        run: () => actions.newSubgroup(groupKey),
      },
      {
        label: "Rename group",
        icon: Pencil,
        disabled: blocked,
        run: () => actions.rename(groupKey),
      },
    ],
    remove: {
      label: "Delete group…",
      icon: Trash2,
      disabled: false,
      run: () => actions.remove(groupKey),
    },
  };
}

export function GroupMenu({
  state,
  actions,
  onClose,
  onRestoreFocus,
}: {
  state: GroupMenuState | null;
  actions: GroupMenuActions;
  onClose: () => void;
  /** Focus goes back to the list when the menu closes, unless an action took it. */
  onRestoreFocus: () => void;
}) {
  return (
    <PointMenu state={state} onClose={onClose} onRestoreFocus={onRestoreFocus} className="min-w-56">
      {(shown) => {
        const { edits, remove } = groupMenuItems(shown, actions);
        const RemoveIcon = remove.icon;
        return (
          <>
            <DropdownMenuLabel className="truncate text-meta font-medium text-muted-foreground">
              # {shown.label}
            </DropdownMenuLabel>
            {edits.map(({ label, icon: Icon, shortcut, disabled, run }) => (
              <DropdownMenuItem key={label} disabled={disabled} onSelect={run}>
                <Icon />
                {label}
                {shortcut ? <MenuKey>{shortcut}</MenuKey> : null}
              </DropdownMenuItem>
            ))}
            {shown.writeBlock ? (
              <p className="px-2 pb-1 text-meta text-muted-foreground">{shown.writeBlock}</p>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={remove.run}>
              <RemoveIcon />
              {remove.label}
            </DropdownMenuItem>
          </>
        );
      }}
    </PointMenu>
  );
}

/** "Delete #pricing?" The sessions stay: they move to No group. */
export function DeleteGroupDialog({
  label,
  open,
  onOpenChange,
  onConfirm,
  onRestoreFocus,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onRestoreFocus: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        size="sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete #{label}?</AlertDialogTitle>
          <AlertDialogDescription>Its sessions move to No group.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            <Trash2 />
            Delete group
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
