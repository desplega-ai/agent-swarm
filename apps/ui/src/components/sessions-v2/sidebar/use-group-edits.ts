import { toast } from "sonner";
import { SESSIONS_TOAST_POSITION } from "@/lib/sessions-v2";
import type { GroupMenuActions } from "./group-menu";
import type { TreeDialogState } from "./tree-dialogs";
import type { TreeMoves } from "./use-tree-moves";

/**
 * Group edits in the tree: the inline New group and New subgroup field,
 * inline Rename, Delete (through its confirm), and New session here. A
 * menu opened on a search result first brings the tree back (the field
 * lives in the tree), then acts.
 */
export function useGroupEdits({
  creating,
  setCreating,
  setRenaming,
  moves,
  dialogs,
  searching,
  setQuery,
  setOpen,
  newSession,
  placeCursor,
  focusTree,
  phone = false,
}: {
  /** The parent the name field shows under (`shared/` for the top level), or null. */
  creating: string | null;
  setCreating: (parent: string | null) => void;
  setRenaming: (key: string | null) => void;
  moves: TreeMoves;
  dialogs: TreeDialogState;
  searching: boolean;
  setQuery: (query: string) => void;
  setOpen: (id: string, open: boolean) => void;
  newSession: (group: string | null) => void;
  placeCursor: (rowKey: string) => void;
  focusTree: () => void;
  /** Touch words in the toasts: a phone has no keys and no drag. */
  phone?: boolean;
}) {
  /**
   * Back to the tree, with the group and its parents open and the cursor on
   * it. Null is No group.
   */
  const revealGroup = (key: string | null) => {
    setQuery("");
    moves.reveal(key);
    placeCursor(key === null ? "box:nogroup" : `group:${key}`);
  };
  const startCreate = (parent: string) => {
    setRenaming(null);
    setCreating(parent);
    if (parent !== "shared/") setOpen(parent, true);
  };
  /** A search result group: show it in the tree first. */
  const inTree = (key: string, run: () => void) => {
    if (searching) revealGroup(key);
    run();
  };

  const groupActions: GroupMenuActions = {
    newSession: (key) => dialogs.afterMenu(() => newSession(key)),
    newSubgroup: (key) => dialogs.afterMenu(() => inTree(key, () => startCreate(key))),
    rename: (key) =>
      dialogs.afterMenu(() =>
        inTree(key, () => {
          setCreating(null);
          setRenaming(key);
        }),
      ),
    remove: (key) => {
      dialogs.takeFocus();
      dialogs.setDeleting({ key, open: true });
    },
  };

  const onCreateDone = (name: string | null) => {
    const parent = creating;
    setCreating(null);
    focusTree();
    if (!parent || name === null) return;
    const made = moves.create(parent, name);
    if (!made) return;
    placeCursor(`group:${made.key}`);
    toast(
      made.existed
        ? "A group with that name already exists."
        : phone
          ? `Group ${moves.labelOf(made.key)} created. Long-press sessions, then tap Move.`
          : `Group ${moves.labelOf(made.key)} created. Drag sessions onto it, or press M on a session.`,
      { position: SESSIONS_TOAST_POSITION },
    );
  };

  /** The inline rename ended: the typed name, or null to cancel. */
  const onRenameDone = (key: string, name: string | null) => {
    setRenaming(null);
    focusTree();
    if (name !== null) void moves.rename(key, name);
  };

  return { revealGroup, startCreate, groupActions, onCreateDone, onRenameDone };
}
