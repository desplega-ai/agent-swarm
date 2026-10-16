import {
  type CredentialBinding,
  type CredentialBindingStore,
  type CredentialBindingStoreContext,
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  type FailedCredentialBinding,
} from "@/scripts-runtime/credential-broker";
import type { EgressSecretEntry } from "@/scripts-runtime/executors/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";
import { getResolvedConfig } from "./db";
import { resolveOAuthBindingToken } from "./oauth-credential-bindings";
import { listRelationalCredentialBindings } from "./script-connections";
import { isApiOnlyConfigKey, isInternalConfigKey } from "./swarm-config-guard";

// Relational-only credential binding store. The legacy SCRIPT_CREDENTIAL_BINDINGS
// swarm-config JSON blob is retired (migrated to relational rows at boot), so
// resolution now reads exclusively from the relational table — including the
// auto-managed bindings that back embedded connection auth.
class RelationalCredentialBindingStore implements CredentialBindingStore {
  listActiveBindings(context: CredentialBindingStoreContext): Promise<CredentialBinding[]> {
    return listRelationalCredentialBindings(context);
  }
}

export type ScriptUserConfig = Record<string, { value: string; isSecret: boolean }>;

/**
 * The values behind `ctx.swarm.config.get(KEY)`: the invoking agent's resolved
 * config (agent over global, plus repo when given), minus the keys the
 * `/api/config/resolved` route never hands out. A script's own SDK bearer
 * already reads every one of these through `ctx.swarm.config_get`, so this
 * widens nothing; it only makes the documented accessor return them. Secret
 * values are registered with the scrubber so they never leave in run output.
 */
function toScriptUserConfig(configs: Awaited<ReturnType<typeof getResolvedConfig>>) {
  const exposed = configs.filter(
    (config) => !isApiOnlyConfigKey(config.key) && !isInternalConfigKey(config.key),
  );
  for (const config of exposed) {
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
}> {
  const resolvedConfigs = await getResolvedConfig(input.agentId, input.repoId);
  // Before the binding loop below, so a binding's own scrubber label wins.
  const userConfig = toScriptUserConfig(resolvedConfigs);
  const configMap = new Map(resolvedConfigs.map((config) => [config.key, config.value]));
  const broker = new CredentialBroker(
    new RelationalCredentialBindingStore(),
    (configKey) => configMap.get(configKey) ?? process.env[configKey],
    DEFAULT_CREDENTIAL_BINDINGS,
    (oauthAuthorizationId) => resolveOAuthBindingToken(oauthAuthorizationId),
  );

  const { resolved, failed } = await broker.resolveBindingsWithFailures({
    agentId: input.agentId,
    repoId: input.repoId,
  });
  for (const binding of resolved) {
    registerVolatileSecret(binding.value, binding.configKey);
  }
  return {
    egressSecrets: resolved,
    failedBindings: failed,
    userConfig,
  };
}

export async function buildScriptCredentialBindings(input: {
  agentId?: string;
  repoId?: string;
}): Promise<EgressSecretEntry[]> {
  return (await buildScriptCredentialBindingsWithFailures(input)).egressSecrets;
}
