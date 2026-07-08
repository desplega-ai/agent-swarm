import {
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  SwarmConfigCredentialBindingStore,
} from "@/scripts-runtime/credential-broker";
import type { EgressSecretEntry } from "@/scripts-runtime/executors/types";
import { registerVolatileSecret, scrubSecrets } from "@/utils/secret-scrubber";
import { getResolvedConfig, getSwarmConfigs } from "./db";
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

export async function buildScriptCredentialBindings(input: {
  agentId?: string;
  repoId?: string;
}): Promise<EgressSecretEntry[]> {
  const resolvedConfigs = getResolvedConfig(input.agentId, input.repoId);
  const configMap = new Map(resolvedConfigs.map((config) => [config.key, config.value]));
  const relationalBindings = listRelationalCredentialBindings(input);
  for (const binding of relationalBindings) {
    if (binding.authKind !== "oauth") continue;
    configMap.set(binding.configKey, "");
    if (!binding.oauthProvider) continue;

    let accessToken: string | undefined;
    try {
      accessToken = await resolveOAuthBindingToken(binding.oauthProvider);
    } catch (err) {
      // A stale/broken provider must not take down unrelated script runs —
      // skip just this binding (the "" shadow above keeps the placeholder
      // unresolved instead of falling through to a same-named config value).
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[script-credential-broker] skipping OAuth binding ${binding.configKey}: token refresh for provider ${binding.oauthProvider} failed: ${scrubSecrets(message)}`,
      );
      continue;
    }
    if (!accessToken) continue;

    configMap.set(binding.configKey, accessToken);
    registerVolatileSecret(accessToken, binding.configKey);
  }

  const broker = new CredentialBroker(
    new RelationalCredentialBindingStore((filters) => getSwarmConfigs(filters)),
    (configKey) => configMap.get(configKey) ?? process.env[configKey],
    DEFAULT_CREDENTIAL_BINDINGS,
  );

  const bindings = broker.resolveBindings({ agentId: input.agentId, repoId: input.repoId });
  for (const binding of bindings) {
    registerVolatileSecret(binding.value, binding.configKey);
  }
  return bindings;
}
