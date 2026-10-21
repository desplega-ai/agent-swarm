/**
 * The group menu (plan Phase 5): New session here, New subgroup, Rename
 * group, Delete group. The "⋯" on a group row, a right-click, and the menu
 * key open it at the row. Groups under Shared with me have none. A group
 * this connection cannot write into (a personal group on the operator key)
 * keeps only Delete, which works there. Delete asks first.
 */

import { FolderPlus, Pencil, Plus, Trash2 } from "lucide-react";
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
      {({ groupKey, label, writeBlock }) => (
        <>
          <DropdownMenuLabel className="truncate text-meta font-medium text-muted-foreground">
            # {label}
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={writeBlock !== null}
            onSelect={() => actions.newSession(groupKey)}
          >
            <Plus />
            New session here
            <MenuKey>C</MenuKey>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={writeBlock !== null}
            onSelect={() => actions.newSubgroup(groupKey)}
          >
            <FolderPlus />
            New subgroup
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={writeBlock !== null}
            onSelect={() => actions.rename(groupKey)}
          >
            <Pencil />
            Rename group
          </DropdownMenuItem>
          {writeBlock ? (
            <p className="px-2 pb-1 text-meta text-muted-foreground">{writeBlock}</p>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(groupKey)}>
            <Trash2 />
            Delete group…
          </DropdownMenuItem>
        </>
      )}
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
