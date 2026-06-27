import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export interface ConfirmOptions {
  /** Capitalized question, e.g. "Cancel This Run?". */
  title: string;
  /** Optional explanatory body. */
  message?: ReactNode;
  /** Confirm button text. Default "Confirm". */
  confirmLabel?: string;
  /** Dismiss button text. Default "Back". */
  cancelLabel?: string;
  /** Destructive styling on the confirm button. */
  danger?: boolean;
}

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

/**
 * Promise-based in-app confirm modal (v4 item 12) — replaces window.confirm.
 *
 * Usage:
 *   const { confirm, confirmDialog } = useConfirm();
 *   …render {confirmDialog} once anywhere in the tree…
 *   if (await confirm({ title: "Cancel This Run?", danger: true,
 *                       confirmLabel: "Cancel Run", cancelLabel: "Keep Running" })) { … }
 *
 * Esc / backdrop click / the dismiss button all resolve false. A second
 * confirm() while one is pending resolves the previous one false (latest wins).
 */
export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  confirmDialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setPending((prev) => {
        prev?.resolve(false);
        return { opts, resolve };
      });
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    setPending((prev) => {
      prev?.resolve(confirmed);
      return null;
    });
  }, []);

  const confirmDialog = (
    <ConfirmDialog pending={pending !== null ? pending.opts : null} onSettle={settle} />
  );
  return { confirm, confirmDialog };
}

function ConfirmDialog(props: {
  pending: ConfirmOptions | null;
  onSettle: (confirmed: boolean) => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const open = props.pending !== null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  const opts = props.pending;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is the native <dialog> Esc cancel (onClose); onClick only handles backdrop dismissal
    <dialog
      ref={ref}
      className="confirm-dialog"
      // Native cancel (Esc) — resolve false.
      onClose={() => {
        if (props.pending !== null) props.onSettle(false);
      }}
      // Backdrop click: the dialog element itself is the event target.
      onClick={(e) => {
        if (e.target === ref.current) props.onSettle(false);
      }}
    >
      {opts !== null ? (
        <div className="confirm-body">
          <h3 className="dialog-title">{opts.title}</h3>
          {opts.message !== undefined ? (
            <div className="confirm-message">{opts.message}</div>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => props.onSettle(false)}>
              {opts.cancelLabel ?? "Back"}
            </button>
            <button
              type="button"
              className={opts.danger ? "btn btn-danger" : "btn btn-primary"}
              // biome-ignore lint/a11y/noAutofocus: confirm modals should focus their primary action
              autoFocus
              onClick={() => props.onSettle(true)}
            >
              {opts.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
