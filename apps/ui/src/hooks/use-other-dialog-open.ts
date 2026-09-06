import { useLayoutEffect, useState } from "react";

const OTHER_DIALOG_SELECTOR =
  '[data-slot="dialog-content"][data-state="open"]:not([data-feedback-popup])';

export function useOtherDialogOpen(): boolean {
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const update = () => setOpen(document.querySelector(OTHER_DIALOG_SELECTOR) !== null);
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return open;
}
