import { useEffect, useState } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useInvitesSupport } from "@/api/hooks/use-invites-support";
import { useOnboarding } from "@/api/hooks/use-onboarding";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
import { markPromptShownThisLoad, useOtherDialogOpen } from "@/hooks/use-other-dialog-open";
import { optionValue, SWARM_ORG_TEAM_SIZE, TEAM_SIZES } from "@/lib/company-profile";
import { useIsAdmin } from "@/lib/use-can";
import { InviteDialog, type InviteDialogIntro } from "@/pages/people/invite-dialog";

const INTRO: InviteDialogIntro = {
  title: "Your first task is done",
  description:
    "Invite a teammate to work with your swarm. They get their own access. No email is sent: you send the link.",
  cancelLabel: "Not now",
};

/** The localStorage key that remembers the offer, per swarm and user. */
export function firstTaskInviteKey(apiUrl: string, userId: string): string {
  return deriveStorageKey(apiUrl, `first-task-invite:${userId}`);
}

function wasOffered(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function rememberOffer(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // No storage (privacy mode): the in-memory `open` still shows it once in this tab.
  }
}

/**
 * Offers the invite dialog (the one of the People page) once, when this tab
 * sees the onboarding first task complete: a payload fetched after mount
 * shows `first_task` not done, and a later one shows it done. Mounted on
 * `/setup` and in the app shell, because sending the first task opens its
 * session. Only for admins on an API that serves invites (the People page
 * gate), not when the company profile says "Just me" (the setup invite card
 * hides then too), and only once a dashboard user is picked. The offer is remembered
 * per swarm and user (localStorage) as it opens, so it never opens again.
 * It waits while another dialog is open.
 */
export function FirstTaskInvitePrompt() {
  const { config } = useConfig();
  const { userId } = useCurrentUser();
  // Shares the onboarding cache: `/setup` and `OnboardingRedirect` poll it.
  const { data, dataUpdatedAt, isFetchedAfterMount } = useOnboarding();
  const isAdmin = useIsAdmin();
  const supported = useInvitesSupport();
  // The raw config rows, as the setup invite card reads them: `/setup` has no StatusProvider.
  const { data: configs } = useConfigs({ scope: "global" });
  const teamSize = optionValue(
    TEAM_SIZES,
    configs?.find((entry) => entry.key === SWARM_ORG_TEAM_SIZE)?.value,
  );
  const hasTeam = configs !== undefined && teamSize !== "1";
  const otherDialogOpen = useOtherDialogOpen();
  const [mountedAt] = useState(Date.now);
  const [sawPending, setSawPending] = useState(false);
  const [open, setOpen] = useState(false);

  const status = data?.state.steps.first_task.status;
  // Never decide on the persisted cache: hydration can count as fetched after mount.
  const fresh = isFetchedAfterMount && dataUpdatedAt >= mountedAt;
  useEffect(() => {
    if (fresh && status !== undefined && status !== "done") setSawPending(true);
  }, [fresh, status]);

  const due =
    sawPending && status === "done" && isAdmin && supported && hasTeam && !otherDialogOpen;
  useEffect(() => {
    if (!due || open || userId === null) return;
    const key = firstTaskInviteKey(config.apiUrl, userId);
    if (wasOffered(key)) return;
    rememberOffer(key);
    setOpen(true);
    // The feedback pop-up waits for another page load.
    markPromptShownThisLoad(config.apiUrl);
  }, [due, open, userId, config.apiUrl]);

  return <InviteDialog open={open} onOpenChange={setOpen} intro={INTRO} />;
}
