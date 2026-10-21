import { useState } from "react";

// True only while `focusQuietly` runs. Radix opens a tooltip in the focus
// event itself, so the flag is set when its `onOpenChange` runs.
let quiet = false;

/**
 * Give the focus back to a header control (after a rename, a menu, or a
 * dialog) without opening its tooltip. An open tooltip would cover the
 * header row.
 */
export function focusQuietly(el: HTMLElement | null | undefined) {
  quiet = true;
  try {
    el?.focus();
  } finally {
    quiet = false;
  }
}

/** `open` and `onOpenChange` for a `Tooltip` that stays shut on a `focusQuietly` focus. */
export function useQuietTooltip() {
  const [open, setOpen] = useState(false);
  return { open, onOpenChange: (next: boolean) => setOpen(next && !quiet) };
}
