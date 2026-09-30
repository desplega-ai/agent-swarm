import {
  getAgentFsDefaultDriveId,
  getAgentFsDefaultOrgId,
  getAgentFsLiveUrl,
} from "../utils/constants";
import { isEnvFlagEnabled } from "../utils/env-flag";

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
    enabled: isEnvFlagEnabled("COMB_ENABLED", false) && internalUrl !== null,
    apiUrl: trimUrl(process.env.AGENT_FS_PUBLIC_URL) ?? internalUrl,
    liveUrl: getAgentFsLiveUrl(),
    orgId: getAgentFsDefaultOrgId() ?? null,
    driveId: getAgentFsDefaultDriveId() ?? null,
  };
}
