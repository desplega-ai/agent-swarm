/**
 * Steering — the single free-text composer that reaches an already-running
 * task. Shared by the task-detail page and the sessions surface so the two
 * can't drift; both render the same `ComposerDock` with a Queue/Interrupt
 * segmented control wired into its action row.
 *
 * Decision 14 — mode is always explicit, **Queue is preselected**. There is no
 * server-side auto-detection.
 *
 * Decision 16 — mode support is advertised before the user picks. The
 * available modes come from the task's derived `supportedSteerModes`
 * (server-side `PROVIDER_STEER_CAPABILITIES`):
 *   - `["steer","queue"]` → both segments live (pi / claude-managed)
 *   - `["queue"]`         → Interrupt disabled with a reason (claude / devin / opencode)
 *   - `[]`                → no toggle at all; the send action is labelled for
 *                           what actually happens — a follow-up task (codex)
 *
 * Attachments are deliberately absent: steering carries text only. The
 * attachment path stays on `SessionComposer`'s `createTask` branch.
 *
 * The draft can be **controlled** (`value` + `onValueChange`). Callers that
 * swap this component in and out — `SessionComposer` flips between the
 * task-creation dock and this one as the leaf task's status changes — must use
 * the controlled form, otherwise the internal draft dies with the unmount and
 * the user loses whatever they had typed.
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useSteerTask } from "@/api/hooks/use-tasks";
import type { AgentTaskStatus, SteerMode, SteerResult } from "@/api/types";
import { ComposerDock } from "@/components/sessions/composer-dock";
import { useCurrentUser } from "@/contexts/current-user-context";
import { SteerModeToggle } from "./steer-mode-toggle";

export interface SteerComposerProps {
  /** The running task to steer. */
  taskId: string;
  /** Derived server-side. `undefined` (older payload) is treated as queue-only. */
  supportedSteerModes?: SteerMode[];
  /** Harness name, used to name the constraint in copy (e.g. "claude"). */
  providerLabel?: string;
  /**
   * Status of the target task. Pre-start tasks (`pending` / `unassigned` /
   * `offered`) accept steering — the message queues and is delivered when the
   * session begins — but there is no running turn to interrupt, so the server
   * degrades `steer` → `queue`. We say so up front instead of letting the user
   * pick a mode that silently won't happen.
   */
  taskStatus?: AgentTaskStatus;
  /** Controlled draft. Omit both to keep the draft internal. */
  value?: string;
  onValueChange?: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Span the full available width (task-detail dock). Sessions chat omits it
   * and keeps the centered chat column. */
  fullWidth?: boolean;
  className?: string;
}

/** Statuses where the task has no live session yet — steering can only queue. */
const PRE_START_STATUSES = new Set<AgentTaskStatus>([
  "pending",
  "unassigned",
  "offered",
  "backlog",
]);

/** Human-readable summary of what the server actually did. */
function describeOutcome(result: SteerResult): string {
  switch (result.outcome) {
    case "steered":
      return "Interrupted — delivered into the running turn.";
    case "queued":
      return result.degradedFrom === "steer"
        ? "Queued — this harness can't interrupt, so it lands at the next turn boundary."
        : "Queued — lands at the next turn boundary.";
    case "promoted":
      return "This harness can't be steered — created a follow-up task instead.";
  }
}

export function SteerComposer({
  taskId,
  supportedSteerModes,
  providerLabel,
  taskStatus,
  value,
  onValueChange,
  placeholder,
  autoFocus,
  fullWidth,
  className,
}: SteerComposerProps) {
  const { userId } = useCurrentUser();
  const steerTask = useSteerTask();
  const [internalDraft, setInternalDraft] = useState("");
  const [mode, setMode] = useState<SteerMode>("queue");

  // Controlled when the caller supplies `value`; the internal state is then
  // never read, so there's no second source of truth to drift.
  const isControlled = value !== undefined;
  const draft = isControlled ? value : internalDraft;
  const setDraft = useCallback(
    (next: string) => {
      if (!isControlled) setInternalDraft(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const modes = supportedSteerModes ?? ["queue"];
  const notStarted = taskStatus !== undefined && PRE_START_STATUSES.has(taskStatus);
  // Two independent reasons Interrupt can be off the table: the harness has no
  // interrupt path at all, or the task has no running turn yet.
  const canInterrupt = modes.includes("steer") && !notStarted;
  const hasLiveDelivery = modes.length > 0;
  const harness = providerLabel ?? "this harness";

  // Guard against a stale selection if the task's provider ever changes under
  // us (task moves to a different agent) — never submit an unsupported mode.
  const effectiveMode: SteerMode = canInterrupt ? mode : "queue";

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || steerTask.isPending) return;
    steerTask.mutate(
      {
        id: taskId,
        message: trimmed,
        mode: effectiveMode,
        requestedByUserId: userId ?? undefined,
      },
      {
        onSuccess: (result) => {
          toast.success(describeOutcome(result));
          setDraft("");
        },
      },
    );
  };

  const routeLabel = !hasLiveDelivery
    ? `${harness} can't be steered — this creates a follow-up task`
    : notStarted
      ? "Queues until the session starts"
      : effectiveMode === "steer"
        ? "Interrupts the current turn"
        : canInterrupt
          ? "Lands at the next turn boundary"
          : `${harness} queues at the next turn boundary`;

  return (
    <ComposerDock
      fullWidth={fullWidth}
      className={className}
      value={draft}
      onChange={setDraft}
      onSubmit={submit}
      isPending={steerTask.isPending}
      isError={steerTask.isError}
      errorMessage={steerTask.error instanceof Error ? steerTask.error.message : "Failed to send"}
      pendingLabel={hasLiveDelivery ? "Sending…" : "Creating follow-up task…"}
      placeholder={
        placeholder ??
        (userId
          ? hasLiveDelivery
            ? notStarted
              ? "Send a message to the queued task…"
              : "Send a message to the running task…"
            : "Add a follow-up for this task…"
          : "Pick an identity above to send messages.")
      }
      disabled={!userId}
      routeLabel={routeLabel}
      sendLabel={hasLiveDelivery ? "Send" : "Create follow-up task"}
      autoFocus={autoFocus}
      modeControl={
        hasLiveDelivery ? (
          <SteerModeToggle
            value={effectiveMode}
            onChange={setMode}
            canInterrupt={canInterrupt}
            interruptDisabledReason={
              notStarted
                ? "This task hasn't started — your message will queue until the session begins."
                : `Interrupt isn't supported on ${harness} — messages queue at the next turn boundary.`
            }
            disabled={!userId || steerTask.isPending}
          />
        ) : null
      }
    />
  );
}
