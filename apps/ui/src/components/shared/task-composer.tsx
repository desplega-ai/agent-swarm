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
 * The send button names the mode, "Steer" or "Follow up". With `showTarget`
 * the placeholder names the task the message goes to (Sessions, where the
 * target is not the page's own task): "Steer #<id> Fix the parser…".
 *
 * A follow-up with files is all or nothing. It is created as a draft, which
 * no worker claims. If any file fails to upload, the composer cancels the
 * draft and the send fails: the text and every file stay in the box, and
 * Send again starts over with a new task. Nothing is left in `draft`, so the
 * heartbeat's abandoned-draft sweep has nothing to promote. If no cancel is
 * confirmed, the composer promotes the draft and goes by the task it gets
 * back: `cancelled` is the same failed send; started means the task runs
 * without the failed files, which stay in the box for a new follow-up. With
 * no answer at all, the send fails and names the task to check.
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
  type ComposeAttachmentUploadResult,
  uploadComposeAttachments,
} from "@/components/sessions/compose-attachment-upload";
import { ComposerDock, partitionAttachmentFiles } from "@/components/sessions/composer-dock";
import { SteerComposer } from "@/components/steering/steer-composer";
import { useCurrentUser } from "@/contexts/current-user-context";
import { taskListTitle } from "@/lib/task-title";
import { useCan } from "@/lib/use-can";

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
  /** Name the target task in the placeholder ("Steer #<id> Fix the parser…"). */
  showTarget?: boolean;
  /** Follow-up route hint. Omitted: the dock's "Routes to Lead". */
  routeLabel?: string;
  /**
   * Called once the follow-up task exists with all its files. Not called
   * when a failed file stays in the box.
   */
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

/** What a send does: steer the target, or start a follow-up task from it. */
export type ComposerMode = "steer" | "follow-up";

/**
 * The mode the composer is in. Files force a follow-up (steering carries
 * text), and so does a harness with no live delivery: its steer box creates
 * a follow-up task.
 */
export function composerMode(
  steerTarget: Pick<AgentTask, "supportedSteerModes"> | null,
): ComposerMode {
  if (!steerTarget) return "follow-up";
  return steerTarget.supportedSteerModes && steerTarget.supportedSteerModes.length === 0
    ? "follow-up"
    : "steer";
}

/** The send button's label: what a send does. */
export const COMPOSER_SEND_LABEL: Record<ComposerMode, string> = {
  steer: "Steer",
  "follow-up": "Follow up",
};

/** A target title longer than this is cut, so the placeholder stays one line. */
const PLACEHOLDER_TITLE_CHARS = 60;

/** The placeholder that names the target: "Steer #<id> Fix the parser…". */
export function composerTargetPlaceholder(mode: ComposerMode, target: AgentTask): string {
  const full = taskListTitle(target);
  // A cut title ends on a whole word.
  const cut =
    full.length > PLACEHOLDER_TITLE_CHARS
      ? full.slice(0, full.lastIndexOf(" ", PLACEHOLDER_TITLE_CHARS)) ||
        full.slice(0, PLACEHOLDER_TITLE_CHARS)
      : full;
  const title = cut.trimEnd().replace(/[.…:;,!?]+$/, "");
  return `${COMPOSER_SEND_LABEL[mode]} #${target.id.slice(0, 8)} ${title}…`;
}

const DRAFT_CALL_ATTEMPTS = 3;
const DRAFT_CALL_RETRY_DELAY_MS = 200;

/** Runs `call` up to 3 times with backoff. Null when every attempt failed. */
async function retried<T>(call: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = 1; attempt <= DRAFT_CALL_ATTEMPTS; attempt++) {
    try {
      const result = await call();
      if (result !== null) return result;
    } catch {
      // Retried below.
    }
    if (attempt < DRAFT_CALL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, DRAFT_CALL_RETRY_DELAY_MS * attempt));
    }
  }
  return null;
}

/**
 * Promotion is idempotent and returns the task as it stands, so a retry also
 * covers a response lost after the server committed it. A task already out
 * of `draft` comes back unchanged: a cancelled draft stays `cancelled`. Null
 * when every attempt failed: the heartbeat then promotes the abandoned draft
 * within 5 minutes.
 */
function promoteDraft(taskId: string) {
  return retried(() => api.promoteDraftTask(taskId));
}

/**
 * Cancels a draft whose files did not all upload, so no worker ever runs it.
 * Cancel is not idempotent (a second one on a cancelled task is a 400), so a
 * failed attempt reads the task: a response lost after the server committed
 * the cancel counts as done. False when no attempt confirmed the cancel.
 */
async function withdrawDraft(taskId: string): Promise<boolean> {
  const confirmed = await retried(async () => {
    try {
      await api.cancelTask(taskId, "Attachment upload failed; the message stays in the composer.");
      return true;
    } catch {
      const task = await api.fetchTask(taskId);
      return task.status === "cancelled" ? true : null;
    }
  });
  return confirmed === true;
}

/** "screenshot.png" or "2 attachments": what failed to upload. */
function failedFilesLabel(failed: ComposeAttachmentUploadResult["failed"]): string {
  return failed.length === 1 ? failed[0].file.name : `${failed.length} attachments`;
}

/**
 * A follow-up whose files failed to upload and that did not start: its draft
 * was cancelled, or its state could not be read. The text and every file stay
 * in the box.
 */
class UnsentFollowUpError extends Error {
  readonly taskId: string;

  constructor(taskId: string, message: string) {
    super(message);
    this.taskId = taskId;
  }
}

function warnNotStarted() {
  toast.warning("Task created, but it could not start yet. It starts within 5 minutes.");
}

export function TaskComposer({
  targetTask,
  canSteer,
  rootTaskId,
  followUpAgentId,
  placeholder = "Follow up on this task…",
  showTarget = false,
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
  // The role's verbs: a follow-up creates a task, steering needs its own verb.
  const mayCreate = useCan("task.create.own");
  const maySteer = useCan("task.steer.own");
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

  const invalidateSent = (taskId: string, parentTaskId: string | undefined) => {
    if (rootTaskId) queryClient.invalidateQueries({ queryKey: ["session", rootTaskId] });
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
    queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    queryClient.invalidateQueries({ queryKey: ["task", taskId, "attachments"] });
    if (parentTaskId) {
      // `exact`: the parent's log, context and steering reads stay as they are.
      queryClient.invalidateQueries({ queryKey: ["task", parentTaskId], exact: true });
      queryClient.invalidateQueries({ queryKey: ["session", parentTaskId] });
    }
  };

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
      if (uploadResult.failed.length > 0) {
        const label = failedFilesLabel(uploadResult.failed);
        const shortId = `#${created.id.slice(0, 8)}`;
        const unsent = `${label} failed to upload, so nothing was sent. Send again to retry.`;
        // All or nothing: cancel the draft and fail the send, so the text and
        // every file stay in the box and Send again starts over.
        if (await withdrawDraft(created.id)) {
          throw new UnsentFollowUpError(created.id, unsent);
        }
        // The cancel is unconfirmed: it may have committed with every response
        // and read lost. Otherwise the draft stays, and the sweep starts it
        // within 5 minutes anyway. Promotion settles both, and its response is
        // the status read: a committed cancel comes back `cancelled`.
        const settled = await promoteDraft(created.id);
        if (settled?.status === "cancelled") {
          throw new UnsentFollowUpError(created.id, unsent);
        }
        if (!settled) {
          // Neither withdrawn nor started, as far as the server said. Claim
          // neither: keep everything in the box and point at the task.
          throw new UnsentFollowUpError(
            created.id,
            `${label} failed to upload, and ${shortId} could not be withdrawn or checked. Open ${shortId} before sending again: it may start within 5 minutes without the file.`,
          );
        }
        // It started without the failed files. The text is gone, so it cannot
        // run twice; the files stay in the box for a new follow-up.
        return {
          created,
          promoted: true,
          failed: uploadResult.failed.map((f) => f.file),
          startedWithout: `${shortId} started without ${label}: it could not be withdrawn. Send the file in a new follow-up.`,
        };
      }
      // A promotion failure never fails the send: the task exists, and a
      // failed send keeps the text, so Send again would create a second task.
      const promoted = isDraft ? (await promoteDraft(created.id)) !== null : true;
      return { created, promoted, failed: [] as File[], startedWithout: null };
    },
    onSuccess: ({ created, promoted, failed, startedWithout }, input) => {
      if (startedWithout) {
        toast.error(startedWithout);
      } else if (!promoted) {
        warnNotStarted();
      }
      invalidateSent(created.id, input.parentTaskId);
      setDraft("");
      setAttachments(failed);
      setAttachmentError(startedWithout);
      // Stay put while files wait in the box: navigating would drop them.
      if (!startedWithout) onCreated?.(created);
    },
    onError: (error, input) => {
      if (!(error instanceof UnsentFollowUpError)) return;
      toast.error(error.message);
      // The draft shows in the session.
      invalidateSent(error.taskId, input.parentTaskId);
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
  const steerTarget = attachments.length === 0 && canSteer && maySteer ? targetTask : null;

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

  const mode = composerMode(steerTarget);
  const sendLabel = COMPOSER_SEND_LABEL[mode];
  const shownTarget = showTarget ? (steerTarget ?? targetTask) : null;
  const targetPlaceholder =
    userId && shownTarget ? composerTargetPlaceholder(mode, shownTarget) : undefined;

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
        sendLabel={sendLabel}
        placeholder={targetPlaceholder}
        className={className}
      />
    );
  }

  if (!mayCreate) return null;
  return (
    <ComposerDock
      value={draft}
      onChange={setDraft}
      onSubmit={submit}
      isPending={createTask.isPending}
      isError={createTask.isError}
      errorMessage={createTask.error instanceof Error ? createTask.error.message : "Failed to send"}
      pendingLabel={pendingLabel}
      placeholder={
        userId ? (targetPlaceholder ?? placeholder) : "Pick an identity above to send messages."
      }
      disabled={!userId}
      routeLabel={routeLabel}
      sendLabel={sendLabel}
      labelledSend
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
