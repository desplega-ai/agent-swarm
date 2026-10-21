/**
 * "Rename session" from Cmd+K (SPEC R8.2): the shipped title rename
 * (`PATCH /api/tasks/{id}/title`, 120 characters). An empty title clears it,
 * and the session shows its first message again. Phase 6 adds the inline
 * rename in the pane header.
 */

import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useSession, useUpdateSessionTitle } from "@/api/hooks/use-sessions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SESSIONS_TOAST_POSITION } from "@/lib/sessions-v2";
import { sessionDisplayTitle } from "@/lib/utils";

const TITLE_MAX = 120;

function RenameForm({ rootTaskId, onDone }: { rootTaskId: string; onDone: () => void }) {
  const { data: detail } = useSession(rootTaskId);
  const updateTitle = useUpdateSessionTitle();
  const current = detail?.root.title ?? "";
  const [draft, setDraft] = useState(current);

  const save = (event: FormEvent) => {
    event.preventDefault();
    onDone();
    const title = draft.trim();
    if (!detail || title === current) return;
    updateTitle.mutate(
      { id: detail.root.id, title: title || null },
      {
        onSuccess: () => toast("Renamed", { position: SESSIONS_TOAST_POSITION }),
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : "Couldn't rename the session", {
            position: SESSIONS_TOAST_POSITION,
          }),
      },
    );
  };

  return (
    <form onSubmit={save} className="grid gap-4">
      <Input
        autoFocus
        aria-label="Session title"
        value={draft}
        maxLength={TITLE_MAX}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        placeholder={detail ? sessionDisplayTitle({ task: detail.root.task }) : undefined}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Rename</Button>
      </DialogFooter>
    </form>
  );
}

export function RenameSessionDialog({
  rootTaskId,
  open,
  onOpenChange,
}: {
  rootTaskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename session</DialogTitle>
          <DialogDescription>Leave it empty to show the first message.</DialogDescription>
        </DialogHeader>
        {/* The content unmounts on close, so each open starts from the current title. */}
        <RenameForm rootTaskId={rootTaskId} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
