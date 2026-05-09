/**
 * New Session dialog (Phase 4 ≥1.76.0).
 *
 * Composer-in-a-dialog: type the first message, click Send → POST /api/tasks
 * with no `parentTaskId` (so it becomes a session root) and the current user
 * id, then navigate to `/sessions/{newId}`. Cmd/Ctrl+Enter submits.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";

export interface NewSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewSessionDialog({ open, onOpenChange }: NewSessionDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { userId } = useCurrentUser();
  const [draft, setDraft] = useState("");

  // Reset draft when the dialog opens fresh.
  useEffect(() => {
    if (open) setDraft("");
  }, [open]);

  const create = useMutation({
    mutationFn: (input: { task: string; requestedByUserId?: string }) =>
      api.createTask({ task: input.task, requestedByUserId: input.requestedByUserId }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onOpenChange(false);
      navigate(`/sessions/${created.id}`);
    },
  });

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || create.isPending) return;
    create.mutate({ task: trimmed, requestedByUserId: userId ?? undefined });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Describe what you want done. The lead picks it up and chains follow-up tasks under this
            root.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3"
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              userId
                ? "What's the goal? (⌘↵ to send)"
                : "Pick an identity in the sidebar before starting a session."
            }
            disabled={!userId || create.isPending}
            rows={3}
            className="min-h-[88px] max-h-[200px] resize-none overflow-y-auto"
            autoFocus
          />
          {create.isError && (
            <p className="text-xs text-status-error-strong">
              {create.error instanceof Error ? create.error.message : "Failed to create session"}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!userId || draft.trim().length === 0 || create.isPending}
            >
              <Send className="h-3.5 w-3.5" />
              {create.isPending ? "Starting…" : "Start session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
