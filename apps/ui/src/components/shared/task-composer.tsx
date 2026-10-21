/**
 * The one message box for a task. The Sessions page and the task detail page
 * both render it, so the two cannot drift.
 *
 * Two modes. The caller decides which one with `canSteer`:
 *   - Steer: the message reaches `targetTask` through
 *     `POST /api/tasks/:id/steer` (or queues until its session starts). The
 *     shared <SteerComposer> renders the Queue/Interrupt toggle. Sessions
 *     steers only a running lead task. The task page steers any assignee.
 *   - Follow up: a new task with `parentTaskId` = `targetTask` (or
 *     `rootTaskId` while the target loads). Without `followUpAgentId` the
 *     server routes it to the Lead (Sessions). With it, the task goes to that
 *     agent with `routingReason: "continuity"` (the task page: same agent).
 *     The server copies the parent's Slack thread, so a Slack task answers in
 *     the same thread.
 *
 * The draft lives here (or with the caller, through `value` and
 * `onValueChange`), never in either child. The two children swap as the
 * target's status changes under a typing user (a poll that flips
 * `pending → in_progress` is enough). A draft owned by the outgoing child
 * would die with its unmount.
 *
 * Attachments go out on the follow-up path only: steering carries text. They
 * also survive the swap. A file added through `renderActions` (the session
 * panel's "Add screenshot") while steering is up switches to the follow-up
 * path, so the message goes out as a follow-up task with the file. A clip
 * from the mic button is one such file: its upload to the draft task puts its
 * transcript in the task text.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { AgentTask } from "@/api/types";
import { RecordAudioButton, useAudioRecorder } from "@/components/sessions/audio-recorder";
import {
  formatComposeAttachmentUploadError,
  uploadComposeAttachments,
} from "@/components/sessions/compose-attachment-upload";
import { ComposerDock, partitionAttachmentFiles } from "@/components/sessions/composer-dock";
import { SteerComposer } from "@/components/steering/steer-composer";
import { useCurrentUser } from "@/contexts/current-user-context";

export interface TaskComposerProps {
  /**
   * The task to steer, or the parent of the follow-up task. Null while it
   * loads: the follow-up then chains off `rootTaskId`.
   */
  targetTask: AgentTask | null;
  /** Steer `targetTask` instead of following up. The caller decides when. */
  canSteer: boolean;
  /**
   * The session root (Sessions). Its chain refreshes after a send, and it is
   * the follow-up parent until `targetTask` loads.
   */
  rootTaskId?: string;
  /**
   * The agent for the follow-up task, sent with `routingReason:
   * "continuity"`. Omitted: the server routes the task to the Lead.
   */
  followUpAgentId?: string;
  /** Follow-up placeholder. The steer box keeps its own. */
  placeholder?: string;
  /** Follow-up route hint. Omitted: the dock's "Routes to Lead". */
  routeLabel?: string;
  /** Called once the follow-up task exists and its uploads are done. */
  onCreated?: (task: AgentTask) => void;
  /** Controlled draft. Omit both to keep the draft internal. */
  value?: string;
  onValueChange?: (next: string) => void;
  /**
   * Extra action-row buttons (the session panel's "Add screenshot"). Receives
   * a callback that adds a file to this composer's attachments.
   */
  renderActions?: (addAttachment: (file: File) => void) => React.ReactNode;
  /** Span the full width (task page). Sessions keeps the centered chat column. */
  fullWidth?: boolean;
  /**
   * The task page's narrow-layout bottom bar: one line until used, 44 px
   * controls. See `ComposerDock`.
   */
  bar?: boolean;
  className?: string;
}

const PROMOTE_ATTEMPTS = 3;
const PROMOTE_RETRY_DELAY_MS = 200;

/**
 * Promotion is idempotent, so a retry also covers a response lost after the
 * server committed it. False when every attempt failed: the heartbeat then
 * promotes the abandoned draft within 5 minutes.
 */
async function promoteDraft(taskId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= PROMOTE_ATTEMPTS; attempt++) {
    try {
      await api.promoteDraftTask(taskId);
      return true;
    } catch {
      if (attempt < PROMOTE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, PROMOTE_RETRY_DELAY_MS * attempt));
      }
    }
  }
  return false;
}

export function TaskComposer({
  targetTask,
  canSteer,
  rootTaskId,
  followUpAgentId,
  placeholder = "Follow up on this task…",
  routeLabel,
  onCreated,
  value,
  onValueChange,
  renderActions,
  fullWidth,
  bar,
  className,
}: TaskComposerProps) {
  const queryClient = useQueryClient();
  const { userId } = useCurrentUser();
  const [internalDraft, setInternalDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploadedCount, setUploadedCount] = useState(0);

  // Controlled when the caller passes `value`: the internal draft is then
  // never read, so there is no second source of truth.
  const isControlled = value !== undefined;
  const draft = isControlled ? value : internalDraft;
  const setDraft = useCallback(
    (next: string) => {
      if (!isControlled) setInternalDraft(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const createTask = useMutation({
    mutationFn: async (input: {
      task: string;
      parentTaskId?: string;
      requestedByUserId?: string;
      attachments: File[];
    }) => {
      setAttachmentError(null);
      setUploadedCount(0);
      // A draft (#1240) until its uploads settle, so no worker claims it
      // before its attachments and any voice-note transcript are in.
      const isDraft = input.attachments.length > 0;
      const created = await api.createTask({
        task: input.task,
        parentTaskId: input.parentTaskId,
        // `POST /api/tasks` requires a routing reason with an explicit agent.
        ...(followUpAgentId
          ? { agentId: followUpAgentId, routingReason: "continuity" as const }
          : {}),
        requestedByUserId: input.requestedByUserId,
        source: "ui",
        draft: isDraft,
      });
      // Per-file failures come back in the result; the upload never throws.
      const uploadResult = await uploadComposeAttachments({
        taskId: created.id,
        files: input.attachments,
        onUploaded: setUploadedCount,
      });
      // Always promote, even after an upload failure. A promotion failure
      // never fails the send: the task exists, and a failed send keeps the
      // text, so Send again would create a second task.
      const promoted = isDraft ? await promoteDraft(created.id) : true;
      return { created, uploadResult, promoted };
    },
    onSuccess: ({ created, uploadResult, promoted }, input) => {
      const uploadError = formatComposeAttachmentUploadError(uploadResult.failed);
      setAttachmentError(uploadError);
      if (uploadError) toast.error(uploadError);
      if (!promoted) {
        toast.warning("Task created, but it could not start yet. It starts within 5 minutes.");
      }
      if (rootTaskId) queryClient.invalidateQueries({ queryKey: ["session", rootTaskId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", created.id] });
      queryClient.invalidateQueries({ queryKey: ["task", created.id, "attachments"] });
      if (input.parentTaskId) {
        // `exact`: the parent's log, context and steering reads stay as they are.
        queryClient.invalidateQueries({ queryKey: ["task", input.parentTaskId], exact: true });
        queryClient.invalidateQueries({ queryKey: ["session", input.parentTaskId] });
      }
      setDraft("");
      if (!uploadError) setAttachments([]);
      onCreated?.(created);
    },
  });

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || createTask.isPending) return;
    createTask.mutate({
      task: trimmed,
      parentTaskId: targetTask?.id ?? rootTaskId,
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

  // Steering carries text only, so a message with attachments goes out as a
  // follow-up task instead.
  const steerTarget = attachments.length === 0 && canSteer ? targetTask : null;

  const addAttachment = useCallback((file: File) => {
    setAttachments((current) => [...current, file]);
    setAttachmentError(null);
  }, []);

  // A clip passes the dock's type and size checks, as a picked file does. The
  // toast covers the steer box, which shows no attachment error.
  const recorder = useAudioRecorder((clip) => {
    const { valid, error } = partitionAttachmentFiles([clip]);
    if (valid.length > 0) return addAttachment(clip);
    setAttachmentError(error);
    if (error) toast.error(error);
  });

  const extraActions = (
    <>
      {renderActions?.(addAttachment)}
      <RecordAudioButton recorder={recorder} disabled={!userId || createTask.isPending} bar={bar} />
    </>
  );

  if (steerTarget) {
    return (
      <SteerComposer
        taskId={steerTarget.id}
        supportedSteerModes={steerTarget.supportedSteerModes}
        providerLabel={steerTarget.provider}
        taskStatus={steerTarget.status}
        value={draft}
        onValueChange={setDraft}
        extraActions={extraActions}
        fullWidth={fullWidth}
        bar={bar}
        className={className}
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
      placeholder={userId ? placeholder : "Pick an identity above to send messages."}
      disabled={!userId}
      routeLabel={routeLabel}
      sendLabel="Send"
      attachments={attachments}
      onAttachmentsChange={(files) => {
        setAttachments(files);
        setAttachmentError(null);
      }}
      attachmentErrorMessage={attachmentError}
      extraActions={extraActions}
      fullWidth={fullWidth}
      bar={bar}
      className={className}
    />
  );
}
