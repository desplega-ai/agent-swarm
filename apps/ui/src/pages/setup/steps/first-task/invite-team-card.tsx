import { UserPlus } from "lucide-react";
import { useState } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useInvitesSupport } from "@/api/hooks/use-invites-support";
import { SetupCard } from "@/components/shared/setup-card";
import { Button } from "@/components/ui/button";
import { optionValue, SWARM_ORG_TEAM_SIZE, TEAM_SIZES } from "@/lib/company-profile";
import { useIsAdmin } from "@/lib/use-can";
import { InviteDialog } from "@/pages/people/invite-dialog";

/**
 * The closing card of `/setup`: invite teammates. Shown to admins on an API
 * that serves invites, unless the company profile says "Solo".
 */
export function InviteTeamCard() {
  // The raw config rows, not `useCompanyProfile`: `/setup` has no StatusProvider.
  const { data: configs } = useConfigs({ scope: "global" });
  const isAdmin = useIsAdmin();
  const supported = useInvitesSupport();
  const [open, setOpen] = useState(false);

  const teamSize = optionValue(
    TEAM_SIZES,
    configs?.find((entry) => entry.key === SWARM_ORG_TEAM_SIZE)?.value,
  );
  if (configs === undefined || teamSize === "1" || !isAdmin || !supported) return null;

  return (
    <>
      <SetupCard
        icon={<UserPlus className="size-4" />}
        title="Invite your team"
        description="Each teammate gets a one-time link and their own access."
        actions={
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Invite
          </Button>
        }
      />
      <InviteDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
