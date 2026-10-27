import { Crown } from "lucide-react";
import { SetupChip } from "@/components/shared/setup-chip";

/** The role tag of an agent row in `/setup`. The lead's tag stands out from the workers'. */
export function AgentRoleChip({ isLead }: { isLead: boolean }) {
  return isLead ? (
    <SetupChip tone="lead">
      <Crown aria-hidden />
      Lead
    </SetupChip>
  ) : (
    <SetupChip>Worker</SetupChip>
  );
}
