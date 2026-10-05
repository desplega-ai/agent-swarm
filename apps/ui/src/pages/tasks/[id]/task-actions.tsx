import {
  Ban,
  Check,
  CircleAlert,
  Copy,
  Ellipsis,
  Hash,
  LifeBuoy,
  Pause,
  Play,
  Reply,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { useCancelTask, usePauseTask, useResumeTask, useRetryTask } from "@/api/hooks/use-tasks";
import type { AgentTask } from "@/api/types";
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
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useLeadCredentialIssue } from "@/hooks/use-lead-credential-issue";
import { TERMINAL_STATUSES } from "@/lib/task-activity";
import { shouldShowTaskFailureHelp } from "@/lib/task-support";
import { cn } from "@/lib/utils";

/** Structured output JSON (`{ status, output, summary }`), or null for plain text. */
export function parseStructuredOutput(raw: string): { output?: string; summary?: string } | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      ("output" in parsed || "summary" in parsed)
    )
      return parsed as { output?: string; summary?: string };
  } catch {
    // Not JSON, fall through.
  }
  return null;
}

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
export interface TaskActionModel {
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
  /** Opens the support dialog. Null when the task does not offer "Get help". */
  getHelp: (() => void) | null;
}

/** Call before the page's early returns: `task` may still be loading. */
export function useTaskActions(
  task: AgentTask | undefined,
  handlers: { onFollowUp: () => void; onGetHelp: () => void },
): TaskActionModel | null {
  const cancelTask = useCancelTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();
  const retryTask = useRetryTask();
  const { userId } = useCurrentUser();
  const { issue, resolved, apiVersion } = useLeadCredentialIssue();
  if (!task) return null;
  const failed = task.status === "failed";
  return {
    task,
    followUp: handlers.onFollowUp,
    retry: () => retryTask.mutate({ task, userId }),
    retrying: retryTask.isPending,
    pause: () => pauseTask.mutate(task.id),
    pausing: pauseTask.isPending,
    resume: () => resumeTask.mutate(task.id),
    resuming: resumeTask.isPending,
    cancel: () => cancelTask.mutate({ id: task.id, reason: "Cancelled from dashboard" }),
    answer: answerText(task.output),
    diagnostics: failed ? buildDiagnostics(task, apiVersion) : null,
    getHelp: shouldShowTaskFailureHelp(task.status, resolved, issue) ? handlers.onGetHelp : null,
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

/** Cancel, behind a confirm step. */
function CancelTaskButton({ onConfirm }: { onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive-outline" size="sm">
          <Ban />
          Cancel
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
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

/** A text button that copies. Only the icon changes, so the width stays. */
function CopyTextButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void copy(text)}
      aria-label={copied ? `${label}: copied` : undefined}
    >
      {copied ? <Check /> : <Copy />}
      {label}
    </Button>
  );
}

function FollowUpButton({ model }: { model: TaskActionModel }) {
  return (
    <Button size="sm" onClick={model.followUp}>
      <Reply />
      Follow up
    </Button>
  );
}

function RetryButton({ model }: { model: TaskActionModel }) {
  return (
    <Button size="sm" onClick={model.retry} disabled={model.retrying}>
      <RotateCcw />
      Retry
    </Button>
  );
}

function PauseButton({ model }: { model: TaskActionModel }) {
  return (
    <Button variant="outline" size="sm" onClick={model.pause} disabled={model.pausing}>
      <Pause />
      Pause
    </Button>
  );
}

function ResumeButton({ model }: { model: TaskActionModel }) {
  return (
    <Button variant="outline" size="sm" onClick={model.resume} disabled={model.resuming}>
      <Play />
      Resume
    </Button>
  );
}

/** The "..." menu: Retry where it is not a button, Copy task id, Get help. */
function MoreActionsMenu({ model }: { model: TaskActionModel }) {
  const { status } = model.task;
  // Failed tasks keep Retry in the menu too: the callout that holds the
  // button is on the Outcome tab in the narrow layout.
  const retryInMenu = status === "completed" || status === "failed";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label="More actions">
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
        {model.getHelp ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={model.getHelp}>
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
 * The hero's actions, by status:
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
        <CopyTextButton text={model.answer} label="Copy answer" />
      ) : null}
      {status === "cancelled" || status === "superseded" ? <RetryButton model={model} /> : null}
      {status === "in_progress" ? <PauseButton model={model} /> : null}
      {status === "paused" ? <ResumeButton model={model} /> : null}
      {terminal ? null : <CancelTaskButton onConfirm={model.cancel} />}
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
      return <CancelTaskButton onConfirm={model.cancel} />;
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
  return (
    <AlertCallout
      tone="error"
      icon={CircleAlert}
      title={duration ? `Failed after ${duration}` : "Failed"}
    >
      <div className="mt-1 space-y-3 text-sm leading-relaxed text-foreground">
        <MarkdownView text={model.task.failureReason || "No failure reason was recorded."} />
        <div className="flex flex-wrap items-center gap-1.5">
          <RetryButton model={model} />
          {model.diagnostics ? (
            <CopyTextButton text={model.diagnostics} label="Copy diagnostics" />
          ) : null}
          {model.getHelp ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={model.getHelp}
              className="ml-auto text-muted-foreground hover:text-foreground"
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
