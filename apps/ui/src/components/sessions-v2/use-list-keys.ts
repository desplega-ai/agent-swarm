import { type KeyboardEvent, useCallback, useLayoutEffect, useRef } from "react";

/** What a list key does. `v` (split) lands in Phase 8. */
type ListKey =
  | "next"
  | "prev"
  | "first"
  | "last"
  | "open"
  | "expand"
  | "collapse"
  | "select"
  | "done"
  | "later"
  | "read"
  | "newTab"
  | "nextUnread"
  | "newSession"
  | "menu"
  | "move"
  | "clear";

type ListKeyHandlers = Partial<Record<ListKey, () => void>>;

/** Letter keys work in both cases (the keycaps show uppercase, SPEC R9). */
const LETTERS: Record<string, ListKey> = {
  j: "next",
  k: "prev",
  o: "open",
  x: "select",
  e: "done",
  l: "later",
  u: "read",
  m: "move",
  t: "newTab",
  n: "nextUnread",
  c: "newSession",
};

const KEYS: Record<string, ListKey> = {
  ArrowDown: "next",
  ArrowUp: "prev",
  Home: "first",
  End: "last",
  Enter: "open",
  ArrowRight: "expand",
  ArrowLeft: "collapse",
  ContextMenu: "menu",
  Escape: "clear",
};

/** Holding these keys moves the cursor on. Every other key acts once per press. */
const REPEATS = new Set<ListKey>(["next", "prev"]);

/** Focus in one of these types text or picks from a list: its keys belong to it. */
const TYPING_TARGET =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="listbox"], [role="menu"], [role="option"]';
/** Enter already activates a focused control. */
const CONTROL_TARGET = 'button, a[href], [role="button"], [role="checkbox"], [role="link"]';

/** The parts of a keydown that decide its list key. A React `KeyboardEvent` fits. */
export interface ListKeyEvent {
  key: string;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  nativeEvent: { isComposing?: boolean };
  target: unknown;
  currentTarget: unknown;
}

type Closest = { closest: (selector: string) => unknown };
const hasClosest = (value: unknown): value is Closest =>
  typeof (value as Closest | null)?.closest === "function";

/**
 * The list key of a keydown on a focused list, or null when the key belongs
 * to something else. It follows the keyboard rules of the dashboard-ui
 * skill: no modifiers (Shift+F10 is the menu key), no composing, no typing
 * targets, and no Enter over a focused control. An open overlay that took
 * the key (a hover card or a tooltip on Escape) marks it handled, so a
 * handled key never reaches the list.
 */
export function listKeyOf(event: ListKeyEvent): ListKey | null {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.shiftKey) return event.key === "F10" && !event.repeat ? "menu" : null;
  const key = KEYS[event.key] ?? LETTERS[event.key.toLowerCase()] ?? null;
  if (!key) return null;
  if (event.repeat && !REPEATS.has(key)) return null;
  const target = event.target;
  if (target !== event.currentTarget && hasClosest(target)) {
    if (target.closest(TYPING_TARGET)) return null;
    if (event.key === "Enter" && target.closest(CONTROL_TARGET)) return null;
  }
  return key;
}

/**
 * The keydown handler of a keyboard list (`j`/`k`, arrows, Home, End, Enter
 * or `o`, `x`, `e`, `l`, `u`, `m`, `t`, `n`, `c`, the menu key, Escape). It runs on
 * the list element, so the keys work only while the list has focus. A key
 * with no handler passes through.
 */
export function useListKeys(handlers: ListKeyHandlers) {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    const key = listKeyOf(event);
    const run = key ? latest.current[key] : undefined;
    if (!run) return;
    event.preventDefault();
    run();
  }, []);
}
