import {
  CredentialBroker,
  DEFAULT_CREDENTIAL_BINDINGS,
  SwarmConfigCredentialBindingStore,
} from "@/scripts-runtime/credential-broker";
import type { EgressSecretEntry } from "@/scripts-runtime/executors/types";
import { getResolvedConfig, getSwarmConfigs } from "./db";

export function buildScriptCredentialBindings(input: {
  agentId?: string;
  repoId?: string;
}): EgressSecretEntry[] {
  const resolvedConfigs = getResolvedConfig(input.agentId, input.repoId);
  const configMap = new Map(resolvedConfigs.map((config) => [config.key, config.value]));
  const broker = new CredentialBroker(
    new SwarmConfigCredentialBindingStore((filters) => getSwarmConfigs(filters)),
    (configKey) => configMap.get(configKey) ?? process.env[configKey],
    DEFAULT_CREDENTIAL_BINDINGS,
  );

  return broker.resolveBindings({ agentId: input.agentId, repoId: input.repoId });
}
