import { useCallback } from "react";
import { useDriveMembers } from "@/api/hooks/use-agent-fs";
import { useCombServiceUserId } from "@/components/comb/use-comb-service-user";

/** Label of the swarm service account, which writes the "[comb:sent ...]" replies. */
const SWARM_AUTHOR_LABEL = "Swarm";

/**
 * agent-fs stores authors as user ids. Show "Swarm" for the swarm service
 * account (`/status` `service_user_id`), else the member's display name, else
 * their email, else the first 8 characters of the id (agent-fs without the
 * `drive-members` feature, or an author who left the drive). `fallback`
 * (step-10) replaces the short id for a user who is not a known member.
 *
 * The service account is labeled here, not renamed in agent-fs: its key can be
 * an operator-supplied account (`API_AGENT_FS_API_KEY`), and the swarm must not
 * overwrite that account's display name.
 */
export function useAuthorLabel(drive: { orgId: string; driveId: string }) {
  const members = useDriveMembers(drive).data?.members;
  const serviceUserId = useCombServiceUserId();
  return useCallback(
    (userId: string | undefined, fallback?: string): string => {
      if (!userId) return "";
      if (userId === serviceUserId) return SWARM_AUTHOR_LABEL;
      const member = members?.find((m) => m.userId === userId);
      if (member) return member.displayName || member.email;
      return fallback ?? (userId.length > 16 ? userId.slice(0, 8) : userId);
    },
    [members, serviceUserId],
  );
}
