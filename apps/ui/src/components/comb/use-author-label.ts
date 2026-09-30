import { useCallback } from "react";
import { useDriveMembers } from "@/api/hooks/use-agent-fs";

/**
 * agent-fs stores authors as user ids. Show the member's display name, else
 * their email, else the first 8 characters of the id (agent-fs without the
 * `drive-members` feature, or an author who left the drive).
 */
export function useAuthorLabel(drive: { orgId: string; driveId: string }) {
  const members = useDriveMembers(drive).data?.members;
  return useCallback(
    (userId: string | undefined): string => {
      if (!userId) return "";
      const member = members?.find((m) => m.userId === userId);
      if (member) return member.displayName || member.email;
      return userId.length > 16 ? userId.slice(0, 8) : userId;
    },
    [members],
  );
}
