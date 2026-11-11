import { AgentFsProvider } from "@/fs/agent-fs-provider";
import { AGENT_FS_API_KEY_CONFIG } from "@/scripts-runtime/script-fs";
import { registerVolatileSecret } from "@/utils/secret-scrubber";
import { getResolvedConfig, getSwarmConfigs } from "./db";

export type AgentFsIdentity = { apiUrl: string; apiKey: string; orgId: string; driveId: string };

/**
 * The agent's own agent-fs identity on its default drive.
 *
 * The key comes only from the agent's own agent-scoped row. A global or repo
 * row, the API env and `API_AGENT_FS_API_KEY` would all act as some other
 * agent-fs identity, so without an own key there is no identity. The
 * non-secret coordinates keep the store-progress lookup: config, then env.
 */
export async function resolveAgentFsIdentity(
  agentId: string | undefined,
  configMap: Map<string, string>,
): Promise<AgentFsIdentity | undefined> {
  if (!agentId) return undefined;
  const [own] = await getSwarmConfigs({
    scope: "agent",
    scopeId: agentId,
    key: AGENT_FS_API_KEY_CONFIG,
  });
  const apiKey = own?.value?.trim();
  if (!apiKey) return undefined;
  const value = (name: string) => configMap.get(name)?.trim() || process.env[name]?.trim();
  const apiUrl = value("AGENT_FS_API_URL")?.replace(/\/+$/, "");
  const orgId = value("AGENT_FS_DEFAULT_ORG_ID");
  const driveId = value("AGENT_FS_DEFAULT_DRIVE_ID");
  if (!apiUrl || !orgId || !driveId || !URL.canParse(apiUrl)) return undefined;
  return { apiUrl, apiKey, orgId, driveId };
}

/** An agent-fs client that acts as the agent itself, never the API's service key. */
export async function agentFsClientFor(
  agentId: string,
): Promise<{ provider: AgentFsProvider; identity: AgentFsIdentity } | undefined> {
  const configs = await getResolvedConfig(agentId);
  const configMap = new Map(configs.map((config) => [config.key, config.value]));
  const identity = await resolveAgentFsIdentity(agentId, configMap);
  if (!identity) return undefined;
  registerVolatileSecret(identity.apiKey, AGENT_FS_API_KEY_CONFIG);
  return { provider: new AgentFsProvider(identity), identity };
}
