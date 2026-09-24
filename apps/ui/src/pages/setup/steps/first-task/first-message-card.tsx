import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { SUGGESTIONS } from "@/components/sessions/new-session-view";
import { StatusBadge } from "@/components/shared/status-badge";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";
import { SetupCard, SetupChip } from "../../components/setup-card";
import type { StepProps } from "../../step-contract";
import { IdentityPicker } from "./identity-picker";

type BadgeStatus = ComponentProps<typeof StatusBadge>["status"];

/**
 * The composer for the first message. Sending creates a UI task for the
 * current user, records it as the onboarding first task, and opens the
 * session. Step 6 completes when that task completes.
 */
export function FirstMessageCard({ onboarding, act }: Pick<StepProps, "onboarding" | "act">) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { state: userState, user, userId, locked } = useCurrentUser();
  // Users and sessions both ship in 1.76.0.
  const { supported: usersSupported } = useFeatureGate("1.76.0");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstTaskId = onboarding.state.firstTaskId;
  const firstTask = onboarding.signals.firstTask;
  const done = onboarding.state.steps.first_task.status === "done";
  const taskPath = (id: string) => (usersSupported ? `/sessions/${id}` : `/tasks/${id}`);
  // A token-bound tab is attributed by the server, so it never picks a user here.
  const needsIdentity = usersSupported && !locked && userState !== "ready";
  const canSend = draft.trim().length > 0 && !sending && !needsIdentity;

  async function send() {
    const task = draft.trim();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const created = await api.createTask({
        task,
        requestedByUserId: userId ?? undefined,
        source: "ui",
      });
      const method = SUGGESTIONS.includes(task) ? "suggestion" : "free_form";
      try {
        await act({ action: "first_task", taskId: created.id, method });
        // Collapse to the header pill: a reload on the session page must not
        // bounce back to /setup while the first task runs.
        await act({ action: "minimize" });
      } catch {
        toast.error("The task was sent, but setup could not record it.");
      }
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void navigate(taskPath(created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send the task.");
      setSending(false);
    }
  }

  const status = firstTask ? (
    <StatusBadge status={firstTask.status as BadgeStatus} />
  ) : firstTaskId ? null : (
    <SetupChip>Not sent</SetupChip>
  );

  if (firstTaskId) {
    return (
      <SetupCard title="Your first message" status={status} bodyClassName="space-y-3">
        {done ? (
          <AlertCallout tone="success" icon={CheckCircle2}>
            Your swarm finished its first task. Setup is complete.
          </AlertCallout>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm">First message sent.</span>
          <Button asChild variant="outline" size="sm">
            <Link to={taskPath(firstTaskId)}>{usersSupported ? "Open session" : "Open task"}</Link>
          </Button>
        </div>
      </SetupCard>
    );
  }

  return (
    <SetupCard title="Your first message" status={status} bodyClassName="space-y-4">
      {needsIdentity ? (
        userState === "pending" ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading users
          </p>
        ) : (
          <IdentityPicker />
        )
      ) : user ? (
        <p className="text-xs text-muted-foreground">
          Sending as <span className="font-medium text-foreground">{user.name}</span>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            type="button"
            variant="outline"
            size="xs"
            className="font-normal"
            onClick={() => setDraft(suggestion)}
            disabled={sending}
          >
            {suggestion}
          </Button>
        ))}
      </div>

      <Textarea
        aria-label="First message"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Describe a goal for the swarm."
        className="min-h-24"
        disabled={sending}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => void send()} disabled={!canSend}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : null}
          Send
        </Button>
        <span className="text-xs text-muted-foreground">
          The lead picks it up. Setup is done when the task completes.
        </span>
      </div>

      {error ? (
        <AlertCallout tone="error" icon={AlertCircle} title="Could not send the message.">
          <span className="break-all font-mono text-muted-foreground">{error}</span>
        </AlertCallout>
      ) : null}
    </SetupCard>
  );
}
