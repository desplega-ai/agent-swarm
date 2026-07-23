import {
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  type FailedCredentialBinding,
  SwarmConfigCredentialBindingStore,
} from "@/scripts-runtime/credential-broker";
import type { EgressSecretEntry } from "@/scripts-runtime/executors/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";
import { getResolvedConfig, getSwarmConfigs } from "./db";
import { getDefaultAuthorizationIdForProvider } from "./db-queries/oauth";
import { resolveOAuthBindingToken } from "./oauth-credential-bindings";
import { listRelationalCredentialBindings } from "./script-connections";

class RelationalCredentialBindingStore extends SwarmConfigCredentialBindingStore {
  override listActiveBindings(
    context: Parameters<SwarmConfigCredentialBindingStore["listActiveBindings"]>[0],
  ) {
    const relational = listRelationalCredentialBindings(context);
    if (relational.length > 0) return relational;
    return super.listActiveBindings(context);
  }
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
}): Promise<{ egressSecrets: EgressSecretEntry[]; failedBindings: FailedCredentialBinding[] }> {
  const resolvedConfigs = getResolvedConfig(input.agentId, input.repoId);
  const configMap = new Map(resolvedConfigs.map((config) => [config.key, config.value]));
  const broker = new CredentialBroker(
    new RelationalCredentialBindingStore(
      (filters) => getSwarmConfigs(filters),
      (provider) => getDefaultAuthorizationIdForProvider(provider) ?? undefined,
    ),
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
  return { egressSecrets: resolved, failedBindings: failed };
}

export async function buildScriptCredentialBindings(input: {
  agentId?: string;
  repoId?: string;
}): Promise<EgressSecretEntry[]> {
  return (await buildScriptCredentialBindingsWithFailures(input)).egressSecrets;
}
