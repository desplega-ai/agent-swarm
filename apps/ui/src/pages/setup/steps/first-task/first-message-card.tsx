import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Send } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { IdentityForm } from "@/components/identity/identity-form";
import { setupExitHref } from "@/components/onboarding/onboarding-redirect";
import { ComposerDock } from "@/components/sessions/composer-dock";
import { BorderBeam } from "@/components/shared/border-beam";
import { SetupCard } from "@/components/shared/setup-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { StatusLine } from "@/components/shared/status-icon";
import { SuggestionChips } from "@/components/shared/suggestion-chips";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import { optionValue, SWARM_ORG_USE_CASE, storedOrgName, USE_CASES } from "@/lib/company-profile";
import { cn } from "@/lib/utils";
import type { StepProps } from "../../step-contract";
import type { LeadReadiness } from "./agents-card";
import { firstTaskStarters } from "./starters";

type BadgeStatus = ComponentProps<typeof StatusBadge>["status"];

/**
 * The first task: the sessions composer at the full setup column width
 * (`SETUP_COLUMN`), with the starter suggestions under it. Sending creates a
 * UI task for the current user, records it as the onboarding first task,
 * minimizes setup, and opens the session. Step 7 completes when that task
 * completes.
 */
/** The composer placeholder while it waits. */
const WAITING_PLACEHOLDER = "Waiting for the lead to come online…";

export function FirstTaskComposer({
  onboarding,
  act,
  lead,
}: Pick<StepProps, "onboarding" | "act"> & { lead: LeadReadiness["state"] }) {
  // An online lead with no verified key can still take the task: Bedrock,
  // Vertex and CRED_CHECK_DISABLE routes never report "verified". The status
  // line above warns instead of blocking.
  const leadReady = lead !== "offline";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { state: userState, userId, locked } = useCurrentUser();
  // Users and sessions both ship in 1.76.0.
  const { supported: usersSupported } = useFeatureGate("1.76.0");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Step 2 asks for the use case; its starters replace the general ones.
  const { data: configs } = useConfigs({ scope: "global" });
  const config = (key: string) => configs?.find((entry) => entry.key === key)?.value || null;
  const suggestions = firstTaskStarters(optionValue(USE_CASES, config(SWARM_ORG_USE_CASE)), {
    company: storedOrgName(config("SWARM_ORG_NAME")),
    website: config("SWARM_ORG_WEBSITE"),
  });

  const taskPath = (id: string) => (usersSupported ? `/sessions/${id}` : `/tasks/${id}`);
  // Step 1 picks the user. This is a fallback for a user that went missing
  // since. A token-bound tab is attributed by the server and never picks.
  const needsIdentity = usersSupported && !locked && userState === "needs-pick";
  const identityReady = !usersSupported || locked || userState === "ready";
  const live = leadReady && identityReady;
  // Focus the composer the first time it goes live, never again: a lead that
  // drops and comes back must not steal focus from wherever the operator is.
  const [wentLive, setWentLive] = useState(false);
  useEffect(() => {
    if (live) setWentLive(true);
  }, [live]);

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
      const method = suggestions.includes(task) ? "suggestion" : "free_form";
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
      <div className="w-full space-y-3">
        <SetupCard
          icon={<Send className="size-4" />}
          title="First task sent"
          status={firstTask ? <StatusBadge status={firstTask.status as BadgeStatus} /> : null}
          actions={
            <Button asChild variant="outline" size="sm">
              {/* A new tab keeps setup open in this one. */}
              <Link
                to={setupExitHref(taskPath(firstTaskId))}
                target="_blank"
                rel="noopener noreferrer"
              >
                {usersSupported ? "Open session" : "Open task"}
                <ExternalLink />
              </Link>
            </Button>
          }
        />
        {done ? <StatusLine tone="done">Setup is complete.</StatusLine> : null}
      </div>
    );
  }

  return (
    // The identity card and the composer span the setup column, like the other steps.
    <div className="flex w-full flex-col items-center gap-4">
      {needsIdentity ? (
        <SetupCard
          title="Who is sending this?"
          description="The swarm attributes tasks to this user."
          className="w-full"
        >
          <IdentityForm surface="setup" autoFocus={false} />
        </SetupCard>
      ) : null}

      <ComposerDock
        value={draft}
        onChange={setDraft}
        onSubmit={() => void send()}
        isPending={sending}
        isError={Boolean(error)}
        errorMessage={error ?? undefined}
        pendingLabel="Sending…"
        placeholder={leadReady ? "Describe a goal for the swarm" : WAITING_PLACEHOLDER}
        disabled={!live}
        sendLabel="Send first task"
        autoFocus={live && !wentLive}
        fullWidth
        className="bg-transparent p-0"
        // Always mounted, so the agents poll never replays an entrance: only opacity changes.
        decoration={
          <BorderBeam
            className={cn(
              "transition-opacity duration-300 ease-snappy",
              live ? "opacity-100" : "opacity-0",
            )}
          />
        }
      />

      <SuggestionChips suggestions={suggestions} onPick={setDraft} disabled={!live || sending} />
    </div>
  );
}
