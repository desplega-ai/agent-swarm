/**
 * Sessions surface (Phase 4 ≥1.76.0) — composer at the bottom of the session
 * detail panel.
 *
 * Submits a new task with `parentTaskId` set to the latest leaf task in the
 * chain so polling-driven refetch shows it as the next chain entry. Source
 * defaults to "api" (server-side). `requestedByUserId` comes from the
 * identity context.
 *
 * Cmd/Ctrl+Enter submits. Plain Enter inserts a newline (multi-line task
 * descriptions are common).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";
import { cn } from "@/lib/utils";

export interface SessionComposerProps {
  rootTaskId: string;
  /**
   * The parent for the next task. Plan calls this the "latest leaf"; the
   * page picks it (e.g. the last task by `createdAt`, or a user-selected
   * branch). If `null`, the new task chains directly off the root.
   */
  latestLeafTaskId: string | null;
  className?: string;
}

export function SessionComposer({ rootTaskId, latestLeafTaskId, className }: SessionComposerProps) {
  const queryClient = useQueryClient();
  const { userId } = useCurrentUser();
  const [draft, setDraft] = useState("");

  // Local mutation — we want to invalidate `["session", rootTaskId]`
  // specifically. `useCreateTask` only invalidates `["tasks"]`, which would
  // miss the chain payload.
  const createTask = useMutation({
    mutationFn: (input: { task: string; parentTaskId?: string; requestedByUserId?: string }) =>
      api.createTask({
        task: input.task,
        parentTaskId: input.parentTaskId,
        requestedByUserId: input.requestedByUserId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", rootTaskId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || createTask.isPending) return;
    createTask.mutate(
      {
        task: trimmed,
        parentTaskId: latestLeafTaskId ?? rootTaskId,
        requestedByUserId: userId ?? undefined,
      },
      {
        onSuccess: () => {
          setDraft("");
        },
      },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter → submit. Plain Enter → newline (default behaviour).
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className={cn(
        "sticky bottom-0 flex flex-col gap-2 border-t border-border bg-card p-3 shrink-0",
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          userId ? "Continue the session… (⌘↵ to send)" : "Pick an identity above to send messages."
        }
        disabled={!userId || createTask.isPending}
        rows={3}
        className="min-h-[72px] max-h-[200px] resize-none overflow-y-auto"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {createTask.isPending ? "Sending…" : "⌘↵ to send"}
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={!userId || draft.trim().length === 0 || createTask.isPending}
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </Button>
      </div>
      {createTask.isError && (
        <p className="text-xs text-status-error-strong">
          {createTask.error instanceof Error ? createTask.error.message : "Failed to send"}
        </p>
      )}
    </form>
  );
}
