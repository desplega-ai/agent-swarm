/**
 * Sessions surface — composer at the bottom of an existing session.
 *
 * Submits a follow-up task with `parentTaskId` set to the latest leaf task in
 * the chain. Backend auto-routes the new task to the Lead agent (see
 * `src/http/tasks.ts`).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  formatComposeAttachmentUploadError,
  uploadComposeAttachments,
} from "./compose-attachment-upload";
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
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploadedCount, setUploadedCount] = useState(0);

  const createTask = useMutation({
    mutationFn: async (input: {
      task: string;
      parentTaskId?: string;
      requestedByUserId?: string;
      attachments: File[];
    }) => {
      setAttachmentError(null);
      setUploadedCount(0);
      const created = await api.createTask({
        task: input.task,
        parentTaskId: input.parentTaskId,
        requestedByUserId: input.requestedByUserId,
        source: "ui",
      });
      const uploadResult = await uploadComposeAttachments({
        taskId: created.id,
        files: input.attachments,
        onUploaded: setUploadedCount,
      });
      return { created, uploadResult };
    },
    onSuccess: ({ created, uploadResult }) => {
      const uploadError = formatComposeAttachmentUploadError(uploadResult.failed);
      setAttachmentError(uploadError);
      if (uploadError) toast.error(uploadError);
      queryClient.invalidateQueries({ queryKey: ["session", rootTaskId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", created.id] });
      queryClient.invalidateQueries({ queryKey: ["task", created.id, "attachments"] });
      setDraft("");
      if (!uploadError) setAttachments([]);
    },
  });

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || createTask.isPending) return;
    createTask.mutate({
      task: trimmed,
      parentTaskId: latestLeafTaskId ?? rootTaskId,
      requestedByUserId: userId ?? undefined,
      attachments,
    });
  };

  const pendingLabel =
    createTask.isPending && attachments.length > 0
      ? uploadedCount > 0
        ? `Uploading ${uploadedCount}/${attachments.length}…`
        : "Creating task…"
      : "Sending…";

  return (
    <ComposerDock
      value={draft}
      onChange={setDraft}
      onSubmit={submit}
      isPending={createTask.isPending}
      isError={createTask.isError}
      errorMessage={createTask.error instanceof Error ? createTask.error.message : "Failed to send"}
      pendingLabel={pendingLabel}
      placeholder={userId ? "Continue the session…" : "Pick an identity above to send messages."}
      disabled={!userId}
      sendLabel="Send"
      attachments={attachments}
      onAttachmentsChange={(files) => {
        setAttachments(files);
        setAttachmentError(null);
      }}
      attachmentErrorMessage={attachmentError}
    />
  );
}
