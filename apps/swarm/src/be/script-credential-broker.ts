import {
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  SwarmConfigCredentialBindingStore,
} from "@/scripts-runtime/credential-broker";
import type { EgressSecretEntry } from "@/scripts-runtime/executors/types";
import { registerVolatileSecret } from "@/utils/secret-scrubber";
import { getResolvedConfig, getSwarmConfigs } from "./db";
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

export function buildScriptCredentialBindings(input: {
  agentId?: string;
  repoId?: string;
}): EgressSecretEntry[] {
  const resolvedConfigs = getResolvedConfig(input.agentId, input.repoId);
  const configMap = new Map(resolvedConfigs.map((config) => [config.key, config.value]));
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
