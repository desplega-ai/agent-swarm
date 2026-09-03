import type { Agent, AgentTaskStatus, ProviderName } from "@/api/types";

export const CREDENTIAL_STATUS_MIN_VERSION = "1.76.0";
export const SUPPORT_EMAIL = "contact@desplega.sh";
export const SUPPORT_DISCORD_URL = "https://discord.gg/KZgfyyDVZa";

export interface LeadCredentialIssue {
  agentId: string;
  agentName: string;
  provider: ProviderName | null;
  missing: string[];
  hint: string | null;
}

function isProviderName(value: string | undefined): value is ProviderName {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "pi" ||
    value === "devin" ||
    value === "claude-managed" ||
    value === "opencode"
  );
}

export function getLeadCredentialIssue(
  agents: Agent[] | undefined,
  credentialStatusSupported: boolean,
): LeadCredentialIssue | null {
  if (!credentialStatusSupported) return null;

  const lead = agents?.find((agent) => agent.isLead);
  if (!lead) return null;

  const hasLegacyMissingReport = lead.credentialMissing != null;
  if (lead.credStatus?.ready !== false && !hasLegacyMissingReport) return null;

  const missing =
    lead.credStatus?.missing && lead.credStatus.missing.length > 0
      ? lead.credStatus.missing
      : (lead.credentialMissing ?? []);

  return {
    agentId: lead.id,
    agentName: lead.name,
    provider: lead.harnessProvider ?? (isProviderName(lead.provider) ? lead.provider : null),
    missing,
    hint: lead.credStatus?.hint ?? null,
  };
}

export function shouldShowTaskFailureHelp(
  status: AgentTaskStatus,
  credentialCheckResolved: boolean,
  leadCredentialIssue: LeadCredentialIssue | null,
): boolean {
  return status === "failed" && credentialCheckResolved && leadCredentialIssue === null;
}
