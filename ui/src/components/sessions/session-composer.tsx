/**
 * Sessions surface — composer at the bottom of an existing session.
 *
 * Submits a follow-up task with `parentTaskId` set to the latest leaf task in
 * the chain. Backend auto-routes the new task to the Lead agent (see
 * `src/http/tasks.ts`).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { useCurrentUser } from "@/contexts/current-user-context";
import { ComposerDock } from "./composer-dock";

export interface SessionComposerProps {
  rootTaskId: string;
  /** Latest leaf task id — the new follow-up chains off it. Falls back to the root. */
  latestLeafTaskId: string | null;
}

export function SessionComposer({ rootTaskId, latestLeafTaskId }: SessionComposerProps) {
  const queryClient = useQueryClient();
  const { userId } = useCurrentUser();
  const [draft, setDraft] = useState("");

  const createTask = useMutation({
    mutationFn: (input: { task: string; parentTaskId?: string; requestedByUserId?: string }) =>
      api.createTask({
        task: input.task,
        parentTaskId: input.parentTaskId,
        requestedByUserId: input.requestedByUserId,
        source: "ui",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session", rootTaskId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setDraft("");
    },
  });

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || createTask.isPending) return;
    createTask.mutate({
      task: trimmed,
      parentTaskId: latestLeafTaskId ?? rootTaskId,
      requestedByUserId: userId ?? undefined,
    });
  };

  return (
    <ComposerDock
      value={draft}
      onChange={setDraft}
      onSubmit={submit}
      isPending={createTask.isPending}
      isError={createTask.isError}
      errorMessage={createTask.error instanceof Error ? createTask.error.message : "Failed to send"}
      placeholder={userId ? "Continue the session…" : "Pick an identity above to send messages."}
      disabled={!userId}
      sendLabel="Send"
    />
  );
}
