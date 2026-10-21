import { useKeyboardShortcuts } from "@/components/shared/questions/keyboard";
import type { ShortcutKeyEvent } from "@/lib/approval-shortcuts";
import { listKeyOf } from "../use-list-keys";

/** The keys the pane takes from the sidebar list: Done, Later, Mark read or unread, and Move. */
export type PaneKey = "done" | "later" | "read" | "move";

/**
 * A pane key, or null. The list key rules apply (no modifiers, no repeats,
 * no composing, no typing target), and no overlay may be open. The sidebar
 * keeps these keys: the tree acts on its cursor row, the bulk bar on the
 * selection.
 */
function matchPaneKey(
  event: ShortcutKeyEvent & { shiftKey?: boolean },
  { overlayOpen }: { overlayOpen: boolean },
): PaneKey | null {
  if (overlayOpen) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("[data-sessions-sidebar]")) return null;
  const key = listKeyOf({
    key: event.key,
    repeat: event.repeat === true,
    altKey: event.altKey === true,
    ctrlKey: event.ctrlKey === true,
    metaKey: event.metaKey === true,
    shiftKey: event.shiftKey === true,
    defaultPrevented: event.defaultPrevented === true,
    nativeEvent: { isComposing: event.isComposing },
    target,
    currentTarget: null,
  });
  return key === "done" || key === "later" || key === "read" || key === "move" ? key : null;
}

/**
 * `e`, `l`, `u`, and `m` on the session in the pane while the focus is
 * outside the sessions sidebar (UX review R9: the header tooltips name
 * these keys). A key with no handler passes through.
 */
export function usePaneKeys(handlers: Partial<Record<PaneKey, () => void>>) {
  useKeyboardShortcuts(matchPaneKey, (key) => {
    const run = handlers[key];
    if (!run) return false;
    run();
    return true;
  });
}
