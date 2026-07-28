/**
 * Sessions surface — composer at the bottom of an existing session.
 *
 * Two modes, decided from the latest leaf task (decision 6):
 *   - The leaf is a **lead** task and it is **in_progress** or **pending** →
 *     the message is *steering*: it reaches the running agent via
 *     `POST /api/tasks/:id/steer`, or queues against a task that hasn't
 *     started yet and lands when the session begins. The shared
 *     <SteerComposer> renders the Queue/Interrupt toggle.
 *   - Anything else → today's behaviour, unchanged: submit a follow-up task
 *     with `parentTaskId` set to the latest leaf. Backend auto-routes the new
 *     task to the Lead agent (see `src/http/tasks.ts`).
 *
 * The draft lives HERE, not in either child. The two composers swap as the
 * leaf task's status changes underneath a typing user (a poll flipping
 * `pending → in_progress` is enough), and a draft owned by the outgoing child
 * would be destroyed by that unmount. This component doesn't unmount across
 * the swap, so a single lifted `draft` carries the text both directions.
 *
 * Attachments stay on the `createTask` path only — steering carries text.
 * They also survive the swap (same reasoning) — they're just not offered while
 * the steering composer is up.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { AgentTask } from "@/api/types";
import { SteerComposer } from "@/components/steering/steer-composer";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  formatComposeAttachmentUploadError,
  uploadComposeAttachments,
} from "./compose-attachment-upload";
import { ComposerDock } from "./composer-dock";

export interface SessionComposerProps {
  rootTaskId: string;
  /**
   * Latest leaf task in the chain — the follow-up chains off it, and it is the
   * steer target when it is a running lead task. Null → falls back to the root.
   */
  latestLeafTask: AgentTask | null;
  /**
   * Steering is only offered when the API server supports it (≥1.122.1).
   * False → the composer behaves exactly as it did before.
   */
  steeringSupported?: boolean;
}

export function SessionComposer({
  rootTaskId,
  latestLeafTask,
  steeringSupported,
}: SessionComposerProps) {
  const latestLeafTaskId = latestLeafTask?.id ?? null;
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

  // Decision 6 — steering targets the thread's latest *lead* task. `pending`
  // counts: the server accepts the message, keeps the row `pending`, and
  // delivers it once the session starts. `unassigned` / `offered` can't occur
  // for a lead leaf task in this view, so they're not enumerated here — the
  // composer handles them anyway via `taskStatus` if that ever changes.
  const steerTarget =
    steeringSupported &&
    latestLeafTask?.isLeadTask &&
    (latestLeafTask.status === "in_progress" || latestLeafTask.status === "pending")
      ? latestLeafTask
      : null;

  if (steerTarget) {
    return (
      <SteerComposer
        taskId={steerTarget.id}
        supportedSteerModes={steerTarget.supportedSteerModes}
        providerLabel={steerTarget.provider}
        taskStatus={steerTarget.status}
        value={draft}
        onValueChange={setDraft}
      />
    );
  }

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
