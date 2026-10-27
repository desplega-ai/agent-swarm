import {
  Ban,
  CircleAlert,
  Copy,
  Ellipsis,
  Hash,
  LifeBuoy,
  Network,
  Pause,
  Play,
  Reply,
  RotateCcw,
} from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useCancelTask, usePauseTask, useResumeTask, useRetryTask } from "@/api/hooks/use-tasks";
import type { AgentTask } from "@/api/types";
import { BetaTag } from "@/components/shared/beta-tag";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { MarkdownView } from "@/components/shared/markdown-view";
import { buildDiagnostics } from "@/components/support/task-failure-help-dialog";
import { AlertCallout } from "@/components/ui/alert-callout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useLeadCredentialIssue } from "@/hooks/use-lead-credential-issue";
import { parseStructuredOutput } from "@/lib/structured-output";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { shouldShowTaskFailureHelp } from "@/lib/task-support";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { NARROW_TARGET } from "./touch-targets";

/** The text "Copy answer" copies: the structured `output` field, else the raw output. */
function answerText(output: string | undefined): string | null {
  if (!output) return null;
  return parseStructuredOutput(output)?.output || output;
}

/**
 * What the operator can do with a task, for every place that offers it: the
 * hero, the sticky bar and the failure callout. The page owns one model, so
 * a request in flight disables its button everywhere.
 */
interface TaskActionModel {
  task: AgentTask;
  /** Scrolls to the follow-up box and focuses it. */
  followUp: () => void;
  retry: () => void;
  retrying: boolean;
  pause: () => void;
  pausing: boolean;
  resume: () => void;
  resuming: boolean;
  cancel: () => void;
  /** The text "Copy answer" copies. Null without output. */
  answer: string | null;
  /** The text "Copy diagnostics" copies. Failed tasks only. */
  diagnostics: string | null;
  /**
   * Opens the support dialog. `opener` gets focus back when it closes. Null
   * when the task does not offer "Get help".
   */
  getHelp: ((opener: HTMLElement | null) => void) | null;
  /** Opens the experimental lineage view. Null when the API predates it. */
  lineage: (() => void) | null;
  /**
   * What the caller's role allows (`useCan`). A hidden action would only
   * return 403. Follow up and Retry create a task.
   */
  allowed: { create: boolean; cancel: boolean; action: boolean };
}

/** First API version that serves `GET /api/tasks/{id}/lineage`. */
const TASK_LINEAGE_MIN_VERSION = "2.4.2";

/** Call before the page's early returns: `task` may still be loading. */
export function useTaskActions(
  task: AgentTask | undefined,
  handlers: { onFollowUp: () => void; onGetHelp: (opener: HTMLElement | null) => void },
): TaskActionModel | null {
  const cancelTask = useCancelTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();
  const retryTask = useRetryTask();
  const navigate = useNavigate();
  const { userId } = useCurrentUser();
  const { issue, resolved, apiVersion } = useLeadCredentialIssue();
  const lineageGate = useFeatureGate(TASK_LINEAGE_MIN_VERSION);
  const allowed = {
    create: useCan("task.create.own"),
    cancel: useCan("task.cancel.own"),
    action: useCan("task.action.own"),
  };
  if (!task) return null;
  const failed = task.status === "failed";
  return {
    task,
    followUp: handlers.onFollowUp,
    // The page moves to the new task.
    retry: () =>
      retryTask.mutate(
        { task, userId },
        {
          onSuccess: (created) => {
            toast.success("Retry created. It runs as a new task.");
            void navigate(`/tasks/${created.id}`);
          },
        },
      ),
    retrying: retryTask.isPending,
    pause: () => pauseTask.mutate(task.id),
    pausing: pauseTask.isPending,
    resume: () => resumeTask.mutate(task.id),
    resuming: resumeTask.isPending,
    cancel: () => cancelTask.mutate({ id: task.id, reason: "Cancelled from dashboard" }),
    answer: answerText(task.output),
    diagnostics: failed ? buildDiagnostics(task, apiVersion) : null,
    getHelp: shouldShowTaskFailureHelp(task.status, resolved, issue) ? handlers.onGetHelp : null,
    lineage: lineageGate.supported ? () => void navigate(`/tasks/${task.id}/lineage`) : null,
    allowed,
  };
}

async function copyWithToast(value: string, message: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch {
    toast.error("Could not copy to the clipboard.");
  }
}

/**
 * The confirm step before Cancel. With a `trigger` it opens itself. Without
 * one, the caller controls it (the narrow layout's menu item opens it).
 */
function CancelTaskDialog({
  open,
  onOpenChange,
  onConfirm,
  trigger,
  returnFocus,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirm: () => void;
  trigger?: ReactNode;
  /** Gets focus when the dialog closes. A trigger gets it on its own. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent
        onCloseAutoFocus={
          returnFocus
            ? (event) => {
                event.preventDefault();
                returnFocus.current?.focus();
              }
            : undefined
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel Task</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to cancel this task? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep Task</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Cancel Task
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Cancel, behind a confirm step. */
function CancelTaskButton({ onConfirm }: { onConfirm: () => void }) {
  return (
    <CancelTaskDialog
      onConfirm={onConfirm}
      trigger={
        <Button variant="destructive-outline" size="sm">
          <Ban />
          Cancel
        </Button>
      }
    />
  );
}

function FollowUpButton({ model }: { model: TaskActionModel }) {
  if (!model.allowed.create) return null;
  return (
    <Button size="sm" onClick={model.followUp}>
      <Reply />
      Follow up
    </Button>
  );
}

function RetryButton({ model, className }: { model: TaskActionModel; className?: string }) {
  if (!model.allowed.create) return null;
  return (
    <Button size="sm" onClick={model.retry} disabled={model.retrying} className={className}>
      <RotateCcw />
      Retry
    </Button>
  );
}

function PauseButton({ model }: { model: TaskActionModel }) {
  if (!model.allowed.action) return null;
  return (
    <Button variant="outline" size="sm" onClick={model.pause} disabled={model.pausing}>
      <Pause />
      Pause
    </Button>
  );
}

function ResumeButton({ model }: { model: TaskActionModel }) {
  if (!model.allowed.action) return null;
  return (
    <Button variant="outline" size="sm" onClick={model.resume} disabled={model.resuming}>
      <Play />
      Resume
    </Button>
  );
}

/** "View lineage", tagged BETA: the experimental tree of every task this one belongs to. */
function LineageMenuItem({ onSelect, className }: { onSelect: () => void; className?: string }) {
  return (
    <DropdownMenuItem className={className} onSelect={onSelect}>
      <Network />
      View lineage
      <BetaTag tooltip="Experimental: the whole task tree" className="ml-auto" side="left" />
    </DropdownMenuItem>
  );
}

/** The wide hero's "..." menu: Retry where it is not a button, Copy task id, View lineage, Get help. */
function MoreActionsMenu({ model }: { model: TaskActionModel }) {
  const { status } = model.task;
  // Failed tasks keep Retry in the menu too, next to Get help: the hero has
  // no Retry button, the error callout under it does.
  const retryInMenu = model.allowed.create && (status === "completed" || status === "failed");
  // "Get help" closes the menu, so the help dialog gives focus back to the trigger.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const getHelp = model.getHelp;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="icon-sm" aria-label="More actions">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {retryInMenu ? (
          <DropdownMenuItem onSelect={model.retry} disabled={model.retrying}>
            <RotateCcw />
            Retry
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => void copyWithToast(model.task.id, "Task id copied.")}>
          <Hash />
          Copy task id
        </DropdownMenuItem>
        {model.lineage ? <LineageMenuItem onSelect={model.lineage} /> : null}
        {getHelp ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => getHelp(triggerRef.current)}>
              <LifeBuoy />
              Get help
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The narrow layout's "..." menu. The narrow hero has no action buttons and
 * the bottom bar holds the message box, so this menu holds every other
 * action for the status:
 * - completed: Copy answer, Retry. Failed, cancelled, superseded: Retry.
 * - in progress: Pause. Paused: Resume.
 * - not finished: Cancel task, behind the confirm step.
 * - always: Copy task id, View lineage (beta), and Get help for a failed task.
 * The trigger and the items are 44 px tall.
 */
export function TaskActionsMenu({ model }: { model: TaskActionModel }) {
  const { status } = model.task;
  const terminal = TERMINAL_STATUSES.has(status);
  const { allowed } = model;
  // Cancel needs a not-finished task and the role's cancel verb.
  const cancellable = !terminal && allowed.cancel;
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // The menu item that opens the confirm step (or the help dialog) is gone
  // when it closes, so focus goes back to the "..." trigger.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const answer = status === "completed" ? model.answer : null;
  const getHelp = model.getHelp;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            variant="ghost"
            size="icon"
            aria-label="More actions"
            className="size-11"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {answer ? (
            <DropdownMenuItem
              className="min-h-11"
              onSelect={() => void copyWithToast(answer, "Answer copied.")}
            >
              <Copy />
              Copy answer
            </DropdownMenuItem>
          ) : null}
          {terminal && allowed.create ? (
            <DropdownMenuItem className="min-h-11" onSelect={model.retry} disabled={model.retrying}>
              <RotateCcw />
              Retry
            </DropdownMenuItem>
          ) : null}
          {status === "in_progress" && allowed.action ? (
            <DropdownMenuItem className="min-h-11" onSelect={model.pause} disabled={model.pausing}>
              <Pause />
              Pause
            </DropdownMenuItem>
          ) : null}
          {status === "paused" && allowed.action ? (
            <DropdownMenuItem
              className="min-h-11"
              onSelect={model.resume}
              disabled={model.resuming}
            >
              <Play />
              Resume
            </DropdownMenuItem>
          ) : null}
          {cancellable ? (
            <DropdownMenuItem
              variant="destructive"
              className="min-h-11"
              onSelect={() => setConfirmingCancel(true)}
            >
              <Ban />
              Cancel task
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="min-h-11"
            onSelect={() => void copyWithToast(model.task.id, "Task id copied.")}
          >
            <Hash />
            Copy task id
          </DropdownMenuItem>
          {model.lineage ? <LineageMenuItem className="min-h-11" onSelect={model.lineage} /> : null}
          {getHelp ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="min-h-11" onSelect={() => getHelp(triggerRef.current)}>
                <LifeBuoy />
                Get help
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {cancellable ? (
        <CancelTaskDialog
          open={confirmingCancel}
          onOpenChange={setConfirmingCancel}
          onConfirm={model.cancel}
          returnFocus={triggerRef}
        />
      ) : null}
    </>
  );
}

/**
 * The wide hero's actions, by status:
 * - completed: Follow up, Copy answer, and "..." (Retry, Copy task id).
 * - failed: "..." only. The error callout under the hero holds Retry, Copy
 *   diagnostics and Get help.
 * - cancelled, superseded: Retry and "...".
 * - in progress: Pause, Cancel and "...". Paused: Resume, Cancel and "...".
 * - not started yet: Cancel and "...".
 */
export function TaskActions({ model, className }: { model: TaskActionModel; className?: string }) {
  const { status } = model.task;
  const terminal = TERMINAL_STATUSES.has(status);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {status === "completed" ? <FollowUpButton model={model} /> : null}
      {status === "completed" && model.answer ? (
        <CopyValueButton value={model.answer}>Copy answer</CopyValueButton>
      ) : null}
      {status === "cancelled" || status === "superseded" ? <RetryButton model={model} /> : null}
      {status === "in_progress" ? <PauseButton model={model} /> : null}
      {status === "paused" ? <ResumeButton model={model} /> : null}
      {terminal || !model.allowed.cancel ? null : <CancelTaskButton onConfirm={model.cancel} />}
      <MoreActionsMenu model={model} />
    </div>
  );
}

/** The one action the sticky bar shows: the status's primary action. */
export function TaskPrimaryAction({ model }: { model: TaskActionModel }) {
  switch (model.task.status) {
    case "completed":
      return <FollowUpButton model={model} />;
    case "failed":
    case "cancelled":
    case "superseded":
      return <RetryButton model={model} />;
    case "in_progress":
      return <PauseButton model={model} />;
    case "paused":
      return <ResumeButton model={model} />;
    default:
      return model.allowed.cancel ? <CancelTaskButton onConfirm={model.cancel} /> : null;
  }
}

/**
 * A failed task's error, open: how long it ran, the reason in body text, and
 * what to do next. It replaces the auto-opening help dialog: "Get help" opens
 * that dialog now.
 */
export function TaskFailureCallout({
  model,
  duration,
}: {
  model: TaskActionModel;
  /** Created to finished, or the harness run time. */
  duration: string | null;
}) {
  const getHelp = model.getHelp;
  return (
    <AlertCallout
      tone="error"
      icon={CircleAlert}
      title={duration ? `Failed after ${duration}` : "Failed"}
    >
      <div className="mt-1 space-y-3 text-sm leading-relaxed text-foreground">
        <MarkdownView text={model.task.failureReason || "No failure reason was recorded."} />
        <div className="flex flex-wrap items-center gap-1.5">
          <RetryButton model={model} className={NARROW_TARGET} />
          {model.diagnostics ? (
            <CopyValueButton value={model.diagnostics} className={NARROW_TARGET}>
              Copy diagnostics
            </CopyValueButton>
          ) : null}
          {getHelp ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => getHelp(event.currentTarget)}
              className={cn("ml-auto text-muted-foreground hover:text-foreground", NARROW_TARGET)}
            >
              <LifeBuoy />
              Get help
            </Button>
          ) : null}
        </div>
      </div>
    </AlertCallout>
  );
}
