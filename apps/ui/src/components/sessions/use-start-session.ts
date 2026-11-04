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
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { SESSION_TREE_KEY } from "@/api/hooks/use-session-tree";
import type { AgentTask } from "@/api/types";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  formatComposeAttachmentUploadError,
  uploadComposeAttachments,
} from "./compose-attachment-upload";
import { type ComposerDockProps, partitionAttachmentFiles } from "./composer-dock";

export interface StartSessionOptions {
  /** Called once the root task exists and its attachments settled. */
  onStarted: (created: AgentTask) => void;
  /** Per-session conversation key for the root task. */
  contextKey?: string;
  /**
   * The asset key (group) the session starts in (sessions v2). Omit it for
   * no group: the server sets the default key.
   */
  key?: string;
  /** Turns what the user typed into the task text, e.g. to append page context. */
  buildTask?: (typed: string) => string;
  /**
   * The draft text, held by the caller so it outlives this composer (the
   * sessions v2 New session tab moves between panes). Default: local state.
   */
  draftState?: [string, (value: string) => void];
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

export function useStartSession({
  onStarted,
  contextKey,
  key,
  buildTask,
  draftState,
}: StartSessionOptions): {
  userId: string | null;
  draft: string;
  setDraft: (value: string) => void;
  isPending: boolean;
  /** Adds one file (a clip from the mic button) after the dock's type and size checks. */
  addAttachment: (file: File) => void;
  /** Spread onto <ComposerDock>; add the surface's placeholder and labels. */
  composerProps: StartSessionComposerProps;
} {
  const queryClient = useQueryClient();
  const { userId } = useCurrentUser();
  const localDraft = useState("");
  const [draft, setDraft] = draftState ?? localDraft;
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
        key,
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
      // A session that starts in a group changes the tree counts (sessions v2).
      queryClient.invalidateQueries({ queryKey: SESSION_TREE_KEY });
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

  // The toast matches the follow-up composer's clip handling in TaskComposer.
  const addAttachment = useCallback((file: File) => {
    const { valid, error } = partitionAttachmentFiles([file]);
    setAttachmentError(error);
    if (valid.length > 0) setAttachments((current) => [...current, ...valid]);
    if (error) toast.error(error);
  }, []);

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
    addAttachment,
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
