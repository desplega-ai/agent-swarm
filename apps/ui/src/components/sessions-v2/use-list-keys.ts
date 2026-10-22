import { type KeyboardEvent, useCallback, useLayoutEffect, useRef } from "react";

/** What a list key does. */
export type ListKey =
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
  | "split"
  | "nextUnread"
  | "newSession"
  | "menu"
  | "move"
  | "clear";

type ListKeyHandlers = Partial<Record<ListKey, () => void>>;

/**
 * The letter keys of a list and their names, in the order the guide lists
 * them. Keys with the same name share one line there (J and K: Move).
 * `cap` is the keycap the guide shows in place of the letter (Enter opens).
 */
export const LETTER_KEYS: readonly { key: string; action: ListKey; label: string; cap?: string }[] =
  [
    { key: "j", action: "next", label: "Move" },
    { key: "k", action: "prev", label: "Move" },
    { key: "o", action: "open", label: "Open", cap: "↵" },
    { key: "e", action: "done", label: "Done" },
    { key: "l", action: "later", label: "Later" },
    { key: "x", action: "select", label: "Select" },
    { key: "m", action: "move", label: "Move to group" },
    { key: "u", action: "read", label: "Read or unread" },
    { key: "c", action: "newSession", label: "New session" },
    { key: "t", action: "newTab", label: "New tab" },
    { key: "v", action: "split", label: "Split" },
    { key: "n", action: "nextUnread", label: "Next unread" },
  ];

/** Letter keys work in both cases (the keycaps show uppercase, SPEC R9). */
const LETTERS: Record<string, ListKey> = Object.fromEntries(
  LETTER_KEYS.map(({ key, action }) => [key, action]),
);

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
  // Chrome autofill sends keydown events with no key.
  if (typeof event.key !== "string") return null;
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
 * or `o`, `x`, `e`, `l`, `u`, `m`, `t`, `v`, `n`, `c`, the menu key, Escape). It runs on
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
