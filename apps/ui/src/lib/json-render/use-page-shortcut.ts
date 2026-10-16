/**
 * Single-key page shortcuts for catalog controls (`Button.shortcut`,
 * `SearchInput.shortcut`).
 *
 * The guards follow the approvals inbox (`lib/approval-shortcuts.ts`): a key
 * typed into a field belongs to the field, Ctrl/Cmd/Alt chords belong to the
 * browser and the OS, and an open dialog or menu owns the keyboard unless the
 * control itself lives inside it (a Button in a Drawer still answers while the
 * Drawer is open).
 */

import { type RefObject, useEffect, useRef } from "react";
import { isTypingTarget, OPEN_OVERLAY } from "@/lib/approval-shortcuts";

/** Letters and digits match case-insensitively and never with Shift; symbols ("/", "?") match as typed. */
export function matchesPageShortcut(
  event: Pick<KeyboardEvent, "key" | "shiftKey">,
  shortcut: string,
): boolean {
  if (/^[a-z0-9]$/i.test(shortcut)) {
    return !event.shiftKey && event.key.toLowerCase() === shortcut.toLowerCase();
  }
  return event.key === shortcut;
}

export function usePageShortcut(
  shortcut: string | undefined,
  ownerRef: RefObject<HTMLElement | null>,
  onPress: () => void,
): void {
  const pressRef = useRef(onPress);
  pressRef.current = onPress;

  useEffect(() => {
    if (!shortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (!matchesPageShortcut(event, shortcut)) return;
      const owner = ownerRef.current;
      if (!owner || !owner.isConnected) return;
      const overlay = document.querySelector(OPEN_OVERLAY);
      if (overlay && !overlay.contains(owner)) return;
      event.preventDefault();
      pressRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shortcut, ownerRef]);
}
