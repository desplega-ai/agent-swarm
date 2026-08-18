#!/usr/bin/env bun

import { getApiKey } from "../utils/api-key.ts";
import { getMcpBaseUrl } from "../utils/constants.ts";
import { scrubSecrets } from "../utils/secret-scrubber.ts";
import {
  auditProfileDivergences,
  type FileReader,
  type ProfileDivergence,
} from "./profile-sync.ts";

export interface ProfileSyncAuditConfig {
  agentId: string;
  apiUrl: string;
  apiKey: string;
  claudeMdPath?: string;
}

export async function runProfileSyncAudit(
  config: ProfileSyncAuditConfig,
  deps: { fetchImpl?: typeof fetch; readFile?: FileReader } = {},
): Promise<{ agentId: string; divergences: ProfileDivergence[] }> {
  const divergences = await auditProfileDivergences(
    { ...config, fetchImpl: deps.fetchImpl },
    deps.readFile,
  );
  return { agentId: config.agentId, divergences };
}

export function profileSyncAuditExitCode(divergences: ProfileDivergence[]): 0 | 2 {
  return divergences.length > 0 ? 2 : 0;
}

if (import.meta.main) {
  const agentId = process.env.AGENT_ID;
  const apiUrl = getMcpBaseUrl();
  const apiKey = getApiKey();
  if (!agentId || !apiUrl || !apiKey) {
    console.error("profile-sync-audit requires AGENT_ID, MCP_BASE_URL, and an API key");
    process.exit(1);
  }

  try {
    const result = await runProfileSyncAudit({
      agentId,
      apiUrl,
      apiKey,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(profileSyncAuditExitCode(result.divergences));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(scrubSecrets(`profile-sync-audit failed: ${message}`));
    process.exit(1);
  }
}
