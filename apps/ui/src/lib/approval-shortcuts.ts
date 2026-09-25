/**
 * Keyboard map for the approval-request pages, as pure functions so the
 * guard ("never fire inside a text field") is unit-tested without a DOM.
 * The hooks in `pages/approval-requests/` feed real events through these.
 */

/** Focus here types text: single keys belong to the field. */
export const TYPING_TARGET =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="textbox"]';
/** Focus here is a control that owns Space/Enter/arrows natively. */
export const CONTROL_TARGET =
  'button, a[href], summary, [role="button"], [role="link"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="option"]';
/** An open dialog, menu, or listbox owns the keyboard. */
export const OPEN_OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** The slice of a KeyboardEvent the matchers read. */
export interface ShortcutKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  /** Anything with `closest(selector)` (an Element); other values count as "page". */
  target?: unknown;
}

export interface ShortcutContext {
  /** A dialog/menu/listbox is open (`document.querySelector(OPEN_OVERLAY)`). */
  overlayOpen?: boolean;
}

function closest(target: unknown, selector: string): boolean {
  if (!target || typeof target !== "object") return false;
  const node = target as { closest?: (selector: string) => unknown };
  return typeof node.closest === "function" && Boolean(node.closest(selector));
}

export function isTypingTarget(target: unknown): boolean {
  return closest(target, TYPING_TARGET);
}

export type DetailShortcut =
  | { type: "next" }
  | { type: "prev" }
  | { type: "approve" }
  | { type: "reject" }
  | { type: "pick"; index: number }
  | { type: "toggle" }
  | { type: "cursor"; delta: 1 | -1 }
  | { type: "expand" }
  | { type: "edit" }
  | { type: "submit" }
  | { type: "help" }
  | { type: "back" }
  | { type: "leave-field" };

/**
 * Detail page: j/k ↑/↓ move between questions, a/r decide, 1–9 pick,
 * Space toggles the highlighted option, ←/→ move that highlight, o opens a
 * collapsed card, Enter jumps into a text field, ⌘/Ctrl+Enter submits, ? opens the sheet, Esc goes back.
 * Inside a text field only ⌘/Ctrl+Enter (submit) and Esc (leave the field)
 * do anything.
 */
export function matchDetailShortcut(
  event: ShortcutKeyEvent,
  context: ShortcutContext = {},
): DetailShortcut | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (context.overlayOpen) return null;
  const mod = Boolean(event.metaKey || event.ctrlKey);
  if (mod && event.key === "Enter" && !event.altKey) return { type: "submit" };
  if (mod || event.altKey) return null;

  const target = event.target;
  if (isTypingTarget(target)) {
    return event.key === "Escape" ? { type: "leave-field" } : null;
  }
  const onControl = closest(target, CONTROL_TARGET);

  switch (event.key) {
    case "j":
      return { type: "next" };
    case "k":
      return { type: "prev" };
    // Arrows belong to a focused radio group (SegmentedControl) or control.
    case "ArrowDown":
      return onControl ? null : { type: "next" };
    case "ArrowUp":
      return onControl ? null : { type: "prev" };
    case "ArrowRight":
      return onControl ? null : { type: "cursor", delta: 1 };
    case "ArrowLeft":
      return onControl ? null : { type: "cursor", delta: -1 };
    case "a":
    case "A":
      return { type: "approve" };
    case "r":
    case "R":
      return { type: "reject" };
    case "o":
    case "O":
      return { type: "expand" };
    // A focused button already reacts to Space.
    case " ":
      return onControl ? null : { type: "toggle" };
    // Enter on a focused card jumps into its text field.
    case "Enter":
      return onControl ? null : { type: "edit" };
    case "?":
      return { type: "help" };
    case "Escape":
      return { type: "back" };
  }
  if (/^[1-9]$/.test(event.key)) return { type: "pick", index: Number(event.key) - 1 };
  return null;
}

export type ListShortcut = { type: "next" } | { type: "prev" } | { type: "open" };

/** List page: j/k ↑/↓ move between rows, Enter opens the highlighted row. */
export function matchListShortcut(
  event: ShortcutKeyEvent,
  context: ShortcutContext = {},
): ListShortcut | null {
  if (event.defaultPrevented || event.isComposing || context.overlayOpen) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const target = event.target;
  if (isTypingTarget(target)) return null;
  const onControl = closest(target, CONTROL_TARGET);
  switch (event.key) {
    case "j":
      return { type: "next" };
    case "k":
      return { type: "prev" };
    case "ArrowDown":
      return onControl ? null : { type: "next" };
    case "ArrowUp":
      return onControl ? null : { type: "prev" };
    case "Enter":
      return onControl ? null : { type: "open" };
  }
  return null;
}

/** ⌘ on Apple platforms, Ctrl elsewhere, for keycaps. */
export function modKeyLabel(platform = typeof navigator === "undefined" ? "" : navigator.platform) {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}
