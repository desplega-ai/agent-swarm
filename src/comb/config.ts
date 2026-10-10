import {
  getAgentFsDefaultDriveId,
  getAgentFsDefaultOrgId,
  getAgentFsLiveUrl,
  isCombEnabled,
} from "../utils/constants";

/** The Comb block of `/status` (`agent_fs.comb`), before snake-casing. */
export interface CombConfig {
  enabled: boolean;
  /** Browser-facing agent-fs URL. */
  apiUrl: string | null;
  liveUrl: string;
  orgId: string | null;
  driveId: string | null;
}

function trimUrl(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || null;
}

/**
 * Comb (the agent-fs review space in the dashboard) settings. Reads
 * `process.env` on every call, because a config upsert reloads the env
 * without a restart.
 */
export function getCombConfig(): CombConfig {
  const internalUrl = trimUrl(process.env.AGENT_FS_API_URL);
  return {
    enabled: isCombEnabled(),
    apiUrl: trimUrl(process.env.AGENT_FS_PUBLIC_URL) ?? internalUrl,
    liveUrl: getAgentFsLiveUrl(),
    orgId: getAgentFsDefaultOrgId() ?? null,
    driveId: getAgentFsDefaultDriveId() ?? null,
  };
}
