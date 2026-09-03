import { useAgents } from "@/api/hooks/use-agents";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { CREDENTIAL_STATUS_MIN_VERSION, getLeadCredentialIssue } from "@/lib/task-support";

export function useLeadCredentialIssue() {
  const gate = useFeatureGate(CREDENTIAL_STATUS_MIN_VERSION);
  const agentsQuery = useAgents();
  const issue = getLeadCredentialIssue(agentsQuery.data, gate.supported);
  const resolved = gate.currentVersion !== null && (!gate.supported || agentsQuery.isFetched);

  return {
    issue,
    resolved,
    apiVersion: gate.currentVersion,
    refetch: agentsQuery.refetch,
  };
}
