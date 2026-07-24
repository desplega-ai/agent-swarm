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

// Relational-only credential binding store. The legacy SCRIPT_CREDENTIAL_BINDINGS
// swarm-config JSON blob is retired (migrated to relational rows at boot), so
// resolution now reads exclusively from the relational table — including the
// auto-managed bindings that back embedded connection auth.
class RelationalCredentialBindingStore implements CredentialBindingStore {
  listActiveBindings(context: CredentialBindingStoreContext): CredentialBinding[] {
    return listRelationalCredentialBindings(context);
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
  return { egressSecrets: resolved, failedBindings: failed };
}

export async function buildScriptCredentialBindings(input: {
  agentId?: string;
  repoId?: string;
}): Promise<EgressSecretEntry[]> {
  return (await buildScriptCredentialBindingsWithFailures(input)).egressSecrets;
}
