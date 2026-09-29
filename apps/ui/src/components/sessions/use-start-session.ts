/**
 * Sessions surface — starts a new session: the draft, attachments, and the
 * root-task create that both the `/sessions` new-session view and the
 * contextual session panel submit through, so a session looks the same
 * wherever it was started.
 *
 * The root task is created with `source: "ui"` and no `agentId`; the API then
 * assigns it to the Lead (see the default-agent branch of `POST /api/tasks`).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { AgentTask } from "@/api/types";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  formatComposeAttachmentUploadError,
  uploadComposeAttachments,
} from "./compose-attachment-upload";
import type { ComposerDockProps } from "./composer-dock";

export interface StartSessionOptions {
  /** Called once the root task exists and its attachments settled. */
  onStarted: (created: AgentTask) => void;
  /** Per-session conversation key for the root task. */
  contextKey?: string;
  /** Turns what the user typed into the task text, e.g. to append page context. */
  buildTask?: (typed: string) => string;
}

export type StartSessionComposerProps = Pick<
  ComposerDockProps,
  | "value"
  | "onChange"
  | "onSubmit"
  | "isPending"
  | "isError"
  | "errorMessage"
  | "pendingLabel"
  | "disabled"
  | "attachments"
  | "onAttachmentsChange"
  | "attachmentErrorMessage"
>;

export function useStartSession({ onStarted, contextKey, buildTask }: StartSessionOptions): {
  userId: string | null;
  draft: string;
  setDraft: (value: string) => void;
  isPending: boolean;
  /** Spread onto <ComposerDock>; add the surface's placeholder and labels. */
  composerProps: StartSessionComposerProps;
} {
  const queryClient = useQueryClient();
  const { userId } = useCurrentUser();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploadedCount, setUploadedCount] = useState(0);

  const create = useMutation({
    mutationFn: async (input: {
      task: string;
      requestedByUserId?: string;
      attachments: File[];
    }) => {
      setAttachmentError(null);
      setUploadedCount(0);
      // Create as a `draft` (#1240) whenever there are attachments to upload
      // — a draft is invisible to dispatch, closing the window where a
      // worker could claim the task and see zero/partial attachments. No
      // attachments means nothing to race, so skip the extra round trip.
      const isDraft = input.attachments.length > 0;
      const created = await api.createTask({
        task: input.task,
        requestedByUserId: input.requestedByUserId,
        source: "ui",
        contextKey,
        draft: isDraft,
      });
      try {
        const uploadResult = await uploadComposeAttachments({
          taskId: created.id,
          files: input.attachments,
          onUploaded: setUploadedCount,
        });
        return { created, uploadResult };
      } finally {
        // Always promote — success, partial failure, or an unexpected throw
        // out of the upload batch must never strand the task in draft.
        if (isDraft) await api.promoteDraftTask(created.id);
      }
    },
    onSuccess: ({ created, uploadResult }) => {
      const uploadError = formatComposeAttachmentUploadError(uploadResult.failed);
      setAttachmentError(uploadError);
      if (uploadError) toast.error(uploadError);
      if (!uploadError) setAttachments([]);
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", created.id] });
      queryClient.invalidateQueries({ queryKey: ["task", created.id, "attachments"] });
      onStarted(created);
    },
  });

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || create.isPending) return;
    create.mutate({
      task: buildTask ? buildTask(trimmed) : trimmed,
      requestedByUserId: userId ?? undefined,
      attachments,
    });
  };

  const pendingLabel =
    create.isPending && attachments.length > 0
      ? uploadedCount > 0
        ? `Uploading ${uploadedCount}/${attachments.length}…`
        : "Creating task…"
      : "Starting…";

  return {
    userId: userId ?? null,
    draft,
    setDraft,
    isPending: create.isPending,
    composerProps: {
      value: draft,
      onChange: setDraft,
      onSubmit: submit,
      isPending: create.isPending,
      isError: create.isError,
      errorMessage:
        create.error instanceof Error ? create.error.message : "Failed to create session",
      pendingLabel,
      disabled: !userId,
      attachments,
      onAttachmentsChange: (files) => {
        setAttachments(files);
        setAttachmentError(null);
      },
      attachmentErrorMessage: attachmentError,
    },
  };
}
