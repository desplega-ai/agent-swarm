import {
  type CredentialBinding,
  type CredentialBindingStore,
  type CredentialBindingStoreContext,
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
} from "@/scripts-runtime/credential-broker";
import type { EgressSecretEntry } from "@/scripts-runtime/executors/types";
import { registerVolatileSecret, scrubSecrets } from "@/utils/secret-scrubber";
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

export async function buildScriptCredentialBindings(input: {
  agentId?: string;
  repoId?: string;
}): Promise<EgressSecretEntry[]> {
  const resolvedConfigs = getResolvedConfig(input.agentId, input.repoId);
  const configMap = new Map(resolvedConfigs.map((config) => [config.key, config.value]));
  const broker = new CredentialBroker(
    new RelationalCredentialBindingStore(),
    (configKey) => configMap.get(configKey) ?? process.env[configKey],
    DEFAULT_CREDENTIAL_BINDINGS,
    async (oauthAuthorizationId) => {
      try {
        return await resolveOAuthBindingToken(oauthAuthorizationId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[script-credential-broker] skipping OAuth authorization ${oauthAuthorizationId}: ${scrubSecrets(message)}`,
        );
        return undefined;
      }
    },
  );

  const bindings = await broker.resolveBindings({ agentId: input.agentId, repoId: input.repoId });
  for (const binding of bindings) {
    registerVolatileSecret(binding.value, binding.configKey);
  }
  return bindings;
}
