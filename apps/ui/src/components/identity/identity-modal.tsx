/**
 * Phase 3: Identity boot modal.
 *
 * shadcn `Dialog` (NOT `Sheet`) around the shared `IdentityForm`: pick a row
 * from `useUsers()` or create one (`name` + optional `email`). On submit the
 * chosen / newly-created user's id is pushed into `CurrentUserContext` via
 * `setUserId`, then the modal closes.
 *
 * Cannot be dismissed without a selection:
 *   - `showCloseButton={false}` removes the `X` close button.
 *   - `onEscapeKeyDown` / `onPointerDownOutside` are preventDefault'd so
 *     escape and overlay clicks do nothing.
 *   - `onOpenChange` is wired to a no-op when the user has no selection.
 *
 * Auto-mounted by `<Providers>` whenever
 *   `useCurrentUser().state === "needs-pick"`
 *   AND `useFeatureGate("1.76.0").supported === true`.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser } from "@/contexts/current-user-context";
import { IdentityForm } from "./identity-form";

export function IdentityModal() {
  const { state } = useCurrentUser();
  const open = state === "needs-pick";

  return (
    <Dialog
      open={open}
      // Block dismissal: the modal can only close once `setUserId` is called
      // (which flips state away from "needs-pick" and unmounts this open=false).
      onOpenChange={(next) => {
        if (!next) {
          // Ignore close attempts. They can only come from the X (which we
          // hide), escape (we preventDefault below), or overlay click (we
          // preventDefault below). This is a defense-in-depth no-op.
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Who are you?</DialogTitle>
          <DialogDescription>
            Pick the user this session belongs to. We'll attribute new tasks and chat sessions to
            them.
          </DialogDescription>
        </DialogHeader>
        <IdentityForm />
      </DialogContent>
    </Dialog>
  );
}
