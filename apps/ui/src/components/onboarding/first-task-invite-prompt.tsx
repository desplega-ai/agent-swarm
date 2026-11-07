import { useEffect, useState } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useInvitesSupport } from "@/api/hooks/use-invites-support";
import { useOnboarding } from "@/api/hooks/use-onboarding";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
import { markPromptShownThisLoad, useOtherDialogOpen } from "@/hooks/use-other-dialog-open";
import { optionValue, SWARM_ORG_TEAM_SIZE, TEAM_SIZES, type TeamSize } from "@/lib/company-profile";
import { useIsAdmin } from "@/lib/use-can";
import { InviteDialog, type InviteDialogIntro } from "@/pages/people/invite-dialog";

const LINK_NOTE = "They get their own access. No email is sent: you send the link.";

/** The pop-up text for the team size in the company profile. */
const INTROS: Record<TeamSize, InviteDialogIntro> = {
  "1": {
    title: "Your first task is done",
    description: `Do you work with someone? Invite them now, or later from People. ${LINK_NOTE}`,
    cancelLabel: "Not now",
  },
  "2-10": {
    title: "Your first task is done",
    description: `Invite a teammate to work with your swarm. ${LINK_NOTE}`,
    cancelLabel: "Not now",
  },
  "11-50": {
    title: "Your first task is done",
    description: `Bring your team in: invite the first teammate now, and the others from People. ${LINK_NOTE}`,
    cancelLabel: "Not now",
  },
  "51+": {
    title: "Your first task is done",
    description: `Bring your team in: invite the first teammate now, and the others from People. ${LINK_NOTE}`,
    cancelLabel: "Not now",
  },
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

/**
 * The swarms (API URLs) where this tab saw the first task not done in a
 * fresh payload. Module state, not component state: `/setup` and the app
 * shell each mount a prompt, and a first task can complete in the 2 s
 * between the setup's last poll and the shell's first one.
 */
const pendingSeen = new Set<string>();

/** Forget what an earlier test saw. */
export function resetFirstTaskInviteWatchForTests() {
  pendingSeen.clear();
}

/** How often a tab that waits for the first task reads the onboarding state. */
const FIRST_TASK_POLL_MS = 5_000;

/** How long the prompt waits after the first task is done, so the final answer renders first. */
const OPEN_DELAY_MS = 2_000;

function rememberOffer(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // No storage (privacy mode): the in-memory `open` still shows it once in this tab.
  }
}

/**
 * Offers the invite dialog (the one of the People page) once, when this tab
 * sees the onboarding first task complete: a payload fetched in this tab
 * shows `first_task` not done, and a later one shows it done. It opens 2 s
 * later, so the final answer of the task renders first. Mounted on
 * `/setup` and in the app shell, because sending the first task opens its
 * session: the shell's prompt knows what the setup's prompt saw. While it
 * waits for the task, it reads the onboarding state every 5 s. Only for
 * admins on an API that serves invites (the People page gate), and only once
 * a dashboard user is picked. The text follows the team size in the company
 * profile (Solo too), so it waits until the profile loads. The offer is remembered per swarm
 * and user (localStorage) as it opens, so it never opens again. It waits
 * while another dialog is open.
 */
export function FirstTaskInvitePrompt() {
  const { config } = useConfig();
  const { userId } = useCurrentUser();
  const isAdmin = useIsAdmin();
  const supported = useInvitesSupport();
  // The raw config rows, as the setup invite card reads them: `/setup` has no StatusProvider.
  const { data: configs } = useConfigs({ scope: "global" });
  const teamSize = optionValue(
    TEAM_SIZES,
    configs?.find((entry) => entry.key === SWARM_ORG_TEAM_SIZE)?.value,
  );
  const profileLoaded = configs !== undefined;
  const [sawPending, setSawPending] = useState(() => pendingSeen.has(config.apiUrl));
  const watching = sawPending && isAdmin && supported && profileLoaded;
  // Shares the onboarding cache with `/setup` and `OnboardingRedirect`. The
  // shell polls it every 30 s only: poll faster while the first task runs.
  const { data, dataUpdatedAt, isFetchedAfterMount } = useOnboarding({
    refetchInterval: (query) =>
      watching && query.state.data?.state.steps.first_task?.status !== "done"
        ? FIRST_TASK_POLL_MS
        : false,
  });
  const otherDialogOpen = useOtherDialogOpen();
  const [mountedAt] = useState(Date.now);
  const [open, setOpen] = useState(false);

  const status = data?.state.steps.first_task.status;
  // Never decide on the persisted cache: hydration can count as fetched after mount.
  const fresh = isFetchedAfterMount && dataUpdatedAt >= mountedAt;
  useEffect(() => {
    if (!fresh || status === undefined || status === "done") return;
    pendingSeen.add(config.apiUrl);
    setSawPending(true);
  }, [fresh, status, config.apiUrl]);

  const due =
    sawPending && status === "done" && isAdmin && supported && profileLoaded && !otherDialogOpen;
  useEffect(() => {
    if (!due || open || userId === null) return;
    const key = firstTaskInviteKey(config.apiUrl, userId);
    if (wasOffered(key)) return;
    // Cleared on unmount, and when a condition of `due` stops holding.
    const timer = setTimeout(() => {
      if (wasOffered(key)) return;
      rememberOffer(key);
      setOpen(true);
      // The feedback pop-up waits for another page load.
      markPromptShownThisLoad(config.apiUrl);
    }, OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [due, open, userId, config.apiUrl]);

  return <InviteDialog open={open} onOpenChange={setOpen} intro={INTROS[teamSize ?? "2-10"]} />;
}
