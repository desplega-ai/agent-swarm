import { useKeyboardShortcuts } from "@/components/shared/questions/keyboard";
import type { ShortcutKeyEvent } from "@/lib/approval-shortcuts";
import { listKeyOf } from "../use-list-keys";

/**
 * The keys that work away from the sidebar list (UX review R9, mockup
 * `paneKey`): Done, Later, Mark read or unread, and Move on the focused
 * pane's session, plus `v` (the split picker) and `c` (a New session tab).
 */
export type PaneKey = "done" | "later" | "read" | "move" | "split" | "newSession";

const PANE_KEYS = new Set<string>(["done", "later", "read", "move", "split", "newSession"]);

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
  return key && PANE_KEYS.has(key) ? (key as PaneKey) : null;
}

/**
 * The pane keys while the focus is outside the sessions sidebar (UX review
 * R9: the tooltips name these keys). A key with no handler passes through:
 * the header handles `e`, `l`, `u`, `m`, and the shell handles `v` and `c`.
 * With a split, only the active pane's header listens (`enabled`), so a key
 * acts on one session.
 */
export function usePaneKeys(handlers: Partial<Record<PaneKey, () => void>>, enabled = true) {
  useKeyboardShortcuts(
    matchPaneKey,
    (key) => {
      const run = handlers[key];
      if (!run) return false;
      run();
      return true;
    },
    enabled,
  );
}
