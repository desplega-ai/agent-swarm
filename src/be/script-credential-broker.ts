import { can } from "@/rbac";
import {
  type CredentialBinding,
  type CredentialBindingStore,
  type CredentialBindingStoreContext,
  CredentialBroker,
  defaultCredentialBindings,
  type FailedCredentialBinding,
  placeholderForConfigKey,
} from "@/scripts-runtime/credential-broker";
import type { EgressSecretEntry, ScriptAgentFsDescriptor } from "@/scripts-runtime/executors/types";
import { AGENT_FS_API_KEY_CONFIG } from "@/scripts-runtime/script-fs";
import { MASKED_SECRET_VALUE } from "@/utils/config-secrets";
import { registerVolatileSecret } from "@/utils/secret-scrubber";
import { resolveAgentFsIdentity } from "./agent-fs-identity";
import { isHiddenFromAgentRead } from "./config-secret-visibility";
import { getAgentById, getResolvedConfig, maskSecrets } from "./db";
import { resolveOAuthBindingToken } from "./oauth-credential-bindings";
import { listRelationalCredentialBindings } from "./script-connections";
import { isApiOnlyConfigKey, isInternalConfigKey, isReservedConfigKey } from "./swarm-config-guard";

/**
 * Binding keys that may also resolve from the API process env when no config
 * row holds them. Only the documented default GitHub binding. Every other
 * binding resolves from swarm_config rows alone.
 */
const ENV_FALLBACK_CONFIG_KEYS = new Set(["GITHUB_TOKEN"]);

/**
 * The value a config binding substitutes. Reserved, API-only and internal keys
 * never resolve, from config or from the env.
 */
function resolveBindingConfigValue(
  configMap: Map<string, string>,
  configKey: string,
): string | undefined {
  if (
    isReservedConfigKey(configKey) ||
    isApiOnlyConfigKey(configKey) ||
    isInternalConfigKey(configKey)
  ) {
    return undefined;
  }
  const value = configMap.get(configKey);
  if (value !== undefined) return value;
  return ENV_FALLBACK_CONFIG_KEYS.has(configKey) ? process.env[configKey] : undefined;
}

// Relational-only credential binding store. The legacy SCRIPT_CREDENTIAL_BINDINGS
// swarm-config JSON blob is retired (migrated to relational rows at boot), so
// resolution now reads exclusively from the relational table — including the
// auto-managed bindings that back embedded connection auth.
class RelationalCredentialBindingStore implements CredentialBindingStore {
  listActiveBindings(context: CredentialBindingStoreContext): Promise<CredentialBinding[]> {
    return listRelationalCredentialBindings(context);
  }
}

/**
 * True when the run's agent is a plain agent: not a lead and without config.read.secrets. Such an
 * agent reads a global secret with exportToEnv=false only masked. A run with no real agent (a
 * workflow or schedule service identity) is not restricted.
 */
async function agentReadsOnlyExportedSecrets(agentId: string | undefined): Promise<boolean> {
  if (!agentId) return false;
  const agent = await getAgentById(agentId);
  if (!agent) return false;
  return !can({
    principal: { kind: "agent", agentId, isLead: agent.isLead === true },
    verb: "config.read.secrets",
    resource: { kind: "none" },
    source: "http",
  }).allow;
}

export type ScriptUserConfig = Record<string, { value: string; isSecret: boolean }>;

/**
 * The values behind `ctx.swarm.config.get(KEY)`: the invoking agent's resolved
 * config (agent over global, plus repo when given), minus the keys the
 * `/api/config/resolved` route never hands out. For a plain agent (not a lead,
 * and without config.read.secrets) a global secret with exportToEnv=false
 * comes back masked, as on `/api/config/resolved`: the agent reaches it through
 * a connection or credential binding, not as a value. Secret values are
 * registered with the scrubber so they never leave in run output.
 */
function toScriptUserConfig(
  configs: Awaited<ReturnType<typeof getResolvedConfig>>,
  maskNonExported: boolean,
) {
  const exposed = configs
    .filter((config) => !isApiOnlyConfigKey(config.key) && !isInternalConfigKey(config.key))
    .map((config) =>
      maskNonExported && isHiddenFromAgentRead(config) ? maskSecrets([config])[0]! : config,
    );
  for (const config of exposed) {
    if (config.isSecret && config.value === MASKED_SECRET_VALUE) continue;
    if (config.isSecret && config.value) {
      registerVolatileSecret(config.value, `config:${config.key}`);
    }
  }
  // fromEntries defines own properties, so a `__proto__` key survives
  // (assigning it into `{}` would hit the prototype setter instead).
  return Object.fromEntries(
    exposed.map((config) => [config.key, { value: config.value, isSecret: config.isSecret }]),
  ) as ScriptUserConfig;
}

/**
 * The agent's default agent-fs drive for `ctx.fs` / `ctx.sh`, and the egress
 * entry that lets the patched fetch put the agent's key on agent-fs requests.
 * Identity rules (own agent-scoped key only): `resolveAgentFsIdentity`.
 */
async function agentFsMount(
  agentId: string | undefined,
  configMap: Map<string, string>,
): Promise<{ descriptor: ScriptAgentFsDescriptor; entry: EgressSecretEntry } | undefined> {
  const identity = await resolveAgentFsIdentity(agentId, configMap);
  if (!agentId || !identity) return undefined;
  const { apiUrl, apiKey, orgId, driveId } = identity;
  const placeholder = placeholderForConfigKey(AGENT_FS_API_KEY_CONFIG);
  return {
    descriptor: { apiUrl, orgId, driveId },
    entry: {
      configKey: AGENT_FS_API_KEY_CONFIG,
      allowedHosts: [new URL(apiUrl).hostname],
      headerTemplate: `Authorization: Bearer ${placeholder}`,
      scope: "agent",
      scopeId: agentId,
      active: true,
      authKind: "config",
      placeholder,
      value: apiKey,
    },
  };
}

/**
 * Resolve credential bindings for a script run, partitioning OAuth bindings
 * whose refresh failed into `failedBindings` (surfaced to the sandbox so the
 * patched fetch throws a typed error) instead of silently dropping them.
 * `resolveOAuthBindingToken` throws OAuthRefreshError on a genuine failure and
 * returns `undefined` only for missing/revoked authorizations.
 */
export async function buildScriptCredentialBindingsWithFailures(input: {
  agentId?: string;
  repoId?: string;
}): Promise<{
  egressSecrets: EgressSecretEntry[];
  failedBindings: FailedCredentialBinding[];
  userConfig: ScriptUserConfig;
  agentFs?: ScriptAgentFsDescriptor;
}> {
  const resolvedConfigs = await getResolvedConfig(input.agentId, input.repoId);
  // Before the binding loop below, so a binding's own scrubber label wins.
  const userConfig = toScriptUserConfig(
    resolvedConfigs,
    await agentReadsOnlyExportedSecrets(input.agentId),
  );
  const configMap = new Map(resolvedConfigs.map((config) => [config.key, config.value]));
  const broker = new CredentialBroker(
    new RelationalCredentialBindingStore(),
    (configKey) => resolveBindingConfigValue(configMap, configKey),
    defaultCredentialBindings(),
    (oauthAuthorizationId) => resolveOAuthBindingToken(oauthAuthorizationId),
  );

  const { resolved, failed } = await broker.resolveBindingsWithFailures({
    agentId: input.agentId,
    repoId: input.repoId,
  });
  for (const binding of resolved) {
    registerVolatileSecret(binding.value, binding.configKey);
  }
  const agentFs = await agentFsMount(input.agentId, configMap);
  if (agentFs) registerVolatileSecret(agentFs.entry.value, AGENT_FS_API_KEY_CONFIG);
  return {
    // First, so the agent's own key claims the placeholder on the agent-fs host
    // before any operator binding for the same config key.
    egressSecrets: agentFs ? [agentFs.entry, ...resolved] : resolved,
    failedBindings: failed,
    userConfig,
    ...(agentFs ? { agentFs: agentFs.descriptor } : {}),
  };
}

export async function buildScriptCredentialBindings(input: {
  agentId?: string;
  repoId?: string;
}): Promise<EgressSecretEntry[]> {
  return (await buildScriptCredentialBindingsWithFailures(input)).egressSecrets;
}
