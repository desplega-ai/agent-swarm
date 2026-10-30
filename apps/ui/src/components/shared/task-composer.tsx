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
 * A follow-up whose files partly failed to upload stays a draft, so no
 * worker starts it without them. The failed files wait under a notice above
 * the box: "Retry upload" sends them to that task and starts it, "Start
 * without it" starts it as is. A retry never creates a second task, and a new
 * follow-up waits until the held one is resolved. A held task left alone
 * starts within 5 minutes (the heartbeat promotes abandoned drafts).
 *
 * Attachments go out on the follow-up path only: steering carries text. They
 * also survive the swap. A file added through `renderActions` (the session
 * panel's "Add screenshot") while steering is up switches to the follow-up
 * path, so the message goes out as a follow-up task with the file. A clip
 * from the mic button is one such file: its upload to the draft task puts its
 * transcript in the task text.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import { CHAT_COLUMN } from "@/lib/chat-width";
import { taskListTitle } from "@/lib/task-title";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

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
   * Called once the follow-up task starts: right after a clean send, or once
   * a held task's failed files are retried or dropped.
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

/** Files that did not upload to a follow-up task, held as a draft for them. */
interface FailedUpload {
  task: AgentTask;
  files: File[];
  error: string;
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
  const [failedUpload, setFailedUpload] = useState<FailedUpload | null>(null);

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
      // A failed file holds the task as a draft until a retry or "Start
      // without it". A promotion failure never fails the send: the task
      // exists, and a failed send keeps the text, so Send again would create
      // a second task.
      const held = uploadResult.failed.length > 0;
      const promoted = isDraft && !held ? await promoteDraft(created.id) : !isDraft;
      return { created, uploadResult, promoted };
    },
    onSuccess: ({ created, uploadResult, promoted }, input) => {
      const uploadError = formatComposeAttachmentUploadError(uploadResult.failed);
      // The task exists, so the failed files leave the box: a new send would
      // start a second task. They wait in the notice for a retry to this task.
      setAttachments([]);
      if (uploadError) {
        setFailedUpload({
          task: created,
          files: uploadResult.failed.map((f) => f.file),
          error: uploadError,
        });
        toast.error(uploadError);
      } else if (!promoted) {
        warnNotStarted();
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
      if (!uploadError) onCreated?.(created);
    },
  });

  // The held task starts: its files are in, or the user dropped them.
  const startHeld = (pending: FailedUpload, promoted: boolean) => {
    setFailedUpload(null);
    if (!promoted) warnNotStarted();
    if (rootTaskId) queryClient.invalidateQueries({ queryKey: ["session", rootTaskId] });
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
    queryClient.invalidateQueries({ queryKey: ["task", pending.task.id] });
    onCreated?.(pending.task);
  };

  // Sends the failed files to the task they belong to, then starts it. Files
  // that fail again stay in the notice and the task stays held.
  const retryUpload = useMutation({
    mutationFn: async (pending: FailedUpload) => {
      const result = await uploadComposeAttachments({
        taskId: pending.task.id,
        files: pending.files,
      });
      const promoted = result.failed.length === 0 ? await promoteDraft(pending.task.id) : false;
      return { pending, result, promoted };
    },
    onSuccess: ({ pending, result, promoted }) => {
      const error = formatComposeAttachmentUploadError(result.failed);
      queryClient.invalidateQueries({ queryKey: ["task", pending.task.id, "attachments"] });
      if (error) {
        setFailedUpload({ ...pending, files: result.failed.map((f) => f.file), error });
        toast.error(error);
        return;
      }
      toast.success(`Uploaded to #${pending.task.id.slice(0, 8)}`);
      startHeld(pending, promoted);
    },
  });

  // Starts the held task without its failed files.
  const startWithout = useMutation({
    mutationFn: async (pending: FailedUpload) => ({
      pending,
      promoted: await promoteDraft(pending.task.id),
    }),
    onSuccess: ({ pending, promoted }) => startHeld(pending, promoted),
  });

  const resolving = retryUpload.isPending || startWithout.isPending;

  const failedUploadNotice = failedUpload ? (
    <div className={cn("shrink-0", !fullWidth && "px-4 pt-2")}>
      <div
        role="alert"
        data-slot="composer-failed-upload"
        className={cn(
          "mb-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs",
          CHAT_COLUMN,
        )}
      >
        <p className="min-w-0 flex-1">
          {failedUpload.error}{" "}
          <span className="text-muted-foreground">
            ({failedUpload.files.map((file) => file.name).join(", ")}). #
            {failedUpload.task.id.slice(0, 8)} waits for it, up to 5 minutes.
          </span>
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          disabled={resolving}
          onClick={() => retryUpload.mutate(failedUpload)}
        >
          <RotateCw className={retryUpload.isPending ? "animate-spin" : undefined} />
          {retryUpload.isPending ? "Retrying…" : "Retry upload"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={resolving}
          onClick={() => startWithout.mutate(failedUpload)}
        >
          Start without it
        </Button>
      </div>
    </div>
  ) : null;

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || createTask.isPending) return;
    // One follow-up at a time: a new one would start before the held one and
    // drop its notice. The text stays in the box.
    if (failedUpload) {
      toast.error(
        `#${failedUpload.task.id.slice(0, 8)} waits for its file. Retry the upload or start it without it first.`,
      );
      return;
    }
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
      <>
        {failedUploadNotice}
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
      </>
    );
  }

  if (!mayCreate) return null;
  return (
    <>
      {failedUploadNotice}
      <ComposerDock
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        isPending={createTask.isPending}
        isError={createTask.isError}
        errorMessage={
          createTask.error instanceof Error ? createTask.error.message : "Failed to send"
        }
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
    </>
  );
}
