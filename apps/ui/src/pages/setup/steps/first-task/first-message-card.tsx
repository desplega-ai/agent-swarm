import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Send } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { IdentityForm } from "@/components/identity/identity-form";
import { BorderBeam } from "@/components/onboarding/border-beam";
import { FadeIn } from "@/components/onboarding/fade-in";
import { StatusLine } from "@/components/onboarding/save-indicator";
import { SetupCard } from "@/components/onboarding/setup-card";
import { ComposerDock } from "@/components/sessions/composer-dock";
import { SUGGESTIONS } from "@/components/sessions/new-session-view";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { StepProps } from "../../step-contract";

type BadgeStatus = ComponentProps<typeof StatusBadge>["status"];

/**
 * The first task: the sessions composer, centered, with the starter
 * suggestions under it. Sending creates a UI task for the current user,
 * records it as the onboarding first task, minimizes setup, and opens the
 * session. Step 6 completes when that task completes.
 */
export function FirstTaskComposer({
  onboarding,
  act,
  leadReady,
}: Pick<StepProps, "onboarding" | "act"> & { leadReady: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { state: userState, userId, locked } = useCurrentUser();
  // Users and sessions both ship in 1.76.0.
  const { supported: usersSupported } = useFeatureGate("1.76.0");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskPath = (id: string) => (usersSupported ? `/sessions/${id}` : `/tasks/${id}`);
  // Step 1 picks the user. This is a fallback for a user that went missing
  // since. A token-bound tab is attributed by the server and never picks.
  const needsIdentity = usersSupported && !locked && userState === "needs-pick";
  const identityReady = !usersSupported || locked || userState === "ready";
  const live = leadReady && identityReady;

  async function send() {
    const task = draft.trim();
    if (!task || sending || !live) return;
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

  const firstTaskId = onboarding.state.firstTaskId;
  if (firstTaskId) {
    const firstTask = onboarding.signals.firstTask;
    const done = onboarding.state.steps.first_task.status === "done";
    return (
      <FadeIn className="mx-auto w-full max-w-2xl space-y-3">
        <SetupCard
          icon={<Send className="size-4" />}
          title="First task sent"
          status={firstTask ? <StatusBadge status={firstTask.status as BadgeStatus} /> : null}
          actions={
            <Button asChild variant="outline" size="sm">
              {/* A new tab keeps setup open in this one. */}
              <Link to={taskPath(firstTaskId)} target="_blank" rel="noopener noreferrer">
                {usersSupported ? "Open session" : "Open task"}
                <ExternalLink />
              </Link>
            </Button>
          }
        />
        {done ? <StatusLine tone="done">Setup is complete.</StatusLine> : null}
      </FadeIn>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4">
      {needsIdentity ? (
        <SetupCard
          title="Who is sending this?"
          description="The swarm attributes tasks to this user."
          className="w-full"
        >
          <IdentityForm
            autoFocus={false}
            submitLabels={{ select: "Use this user", create: "Create user" }}
          />
        </SetupCard>
      ) : null}

      <FadeIn className="w-full">
        <ComposerDock
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          isPending={sending}
          isError={Boolean(error)}
          errorMessage={error ?? undefined}
          pendingLabel="Sending…"
          placeholder={
            leadReady ? "Describe a goal for the swarm" : "Waiting for the lead to come online…"
          }
          disabled={!live}
          sendLabel="Send first task"
          autoFocus={live}
          className="bg-transparent p-0"
          decoration={live ? <BorderBeam className="animate-in fade-in-0 duration-500" /> : null}
        />
      </FadeIn>

      <FadeIn delay={0.06} className="flex flex-wrap items-center justify-center gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => setDraft(suggestion)}
            disabled={!live || sending}
            className="rounded-md text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
          >
            <Badge
              variant="outline"
              className="px-3 py-1 font-normal normal-case text-xs hover:border-primary/40 hover:bg-muted/60 hover-linger transition-colors"
            >
              {suggestion}
            </Badge>
          </button>
        ))}
      </FadeIn>
    </div>
  );
}
