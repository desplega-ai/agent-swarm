/**
 * Shared Enter-key submit policy for prompt/chat composers.
 *
 * Desktop (fine pointer, hardware keyboard): Enter submits, Shift+Enter
 * inserts a newline, Cmd/Ctrl+Enter always submits.
 *
 * Touch devices with a soft keyboard (iOS/Android): the Return key sends a
 * plain `Enter` keydown with no modifiers — identical to a desktop Enter, so
 * the event shape alone can't tell them apart. Instead this keys off input
 * capability (`pointer: coarse`) checked live at keydown time: Enter inserts
 * a newline there, and the user submits with the send button.
 *
 * IME composition (`isComposing` / keyCode 229) never submits, on any device.
 */

/** The slice of a KeyboardEvent the policy reads, kept DOM-free for unit tests. */
export interface EnterKeyDownEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/** True on a touch device with a soft keyboard (no hardware Enter key). */
export function isCoarsePointerInput(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export function shouldSubmitOnEnterKeyDown(
  e: EnterKeyDownEvent,
  isCoarsePointer: boolean,
): boolean {
  if (e.key !== "Enter") return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey) return true;
  if (isCoarsePointer) return false;
  return !e.shiftKey;
}
