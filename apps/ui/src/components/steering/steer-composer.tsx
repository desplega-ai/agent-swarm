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
 *   - `["steer","queue"]` → both segments live (pi / claude-managed / devin / opencode)
 *   - `["queue"]`         → Interrupt disabled with a reason (claude)
 *   - `[]`                → no toggle at all; the send action is labelled for
 *                           what actually happens — a follow-up task (codex)
 *
 * Attachments are deliberately absent: steering carries text only. The
 * attachment path stays on `SessionComposer`'s `createTask` branch.
 */

import { useState } from "react";
import { toast } from "sonner";
import { useSteerTask } from "@/api/hooks/use-tasks";
import type { SteerMode, SteerResult } from "@/api/types";
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
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

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
  placeholder,
  autoFocus,
  className,
}: SteerComposerProps) {
  const { userId } = useCurrentUser();
  const steerTask = useSteerTask();
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<SteerMode>("queue");

  const modes = supportedSteerModes ?? ["queue"];
  const canInterrupt = modes.includes("steer");
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
    : effectiveMode === "steer"
      ? "Interrupts the current turn"
      : canInterrupt
        ? "Lands at the next turn boundary"
        : `${harness} queues at the next turn boundary`;

  return (
    <ComposerDock
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
            ? "Send a message to the running task…"
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
            interruptDisabledReason={`Interrupt isn't supported on ${harness} — messages queue at the next turn boundary.`}
            disabled={!userId || steerTask.isPending}
          />
        ) : null
      }
    />
  );
}
