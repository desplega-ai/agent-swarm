import type { SwarmConfig } from "@/types";
import {
  CREDENTIAL_BINDINGS_CONFIG_KEY,
  type CredentialBinding,
  type CredentialBindingStore,
  type CredentialBindingStoreContext,
  normalizeCredentialBindingsDocument,
  placeholderForConfigKey,
} from "./types";

type ConfigReader = (filters: { key: string }) => SwarmConfig[];

function appliesToContext(binding: CredentialBinding, context: CredentialBindingStoreContext) {
  if (binding.scope === "global") return true;
  if (binding.scope === "agent")
    return Boolean(context.agentId && binding.scopeId === context.agentId);
  if (binding.scope === "repo")
    return Boolean(context.repoId && binding.scopeId === context.repoId);
  return false;
}

function parseBindingsFromConfig(config: SwarmConfig): CredentialBinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(config.value);
  } catch {
    return [];
  }

  try {
    return normalizeCredentialBindingsDocument(raw).map((binding) => ({
      ...binding,
      scope: binding.scope ?? (config.scope as CredentialBinding["scope"]),
      scopeId: binding.scopeId ?? config.scopeId ?? null,
    }));
  } catch {
    return [];
  }
}

export class SwarmConfigCredentialBindingStore implements CredentialBindingStore {
  constructor(private readonly readConfigs: ConfigReader) {}

  listActiveBindings(context: CredentialBindingStoreContext): CredentialBinding[] {
    const rows = this.readConfigs({ key: CREDENTIAL_BINDINGS_CONFIG_KEY });
    return rows
      .flatMap(parseBindingsFromConfig)
      .filter((binding) => binding.active !== false)
      .filter((binding) => appliesToContext(binding, context))
      .filter((binding) =>
        binding.headerTemplate.includes(placeholderForConfigKey(binding.configKey)),
      );
  }
}
