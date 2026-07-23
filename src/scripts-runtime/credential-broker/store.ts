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

function parseBindingsFromConfig(
  config: SwarmConfig,
  resolveLegacyOAuthProvider?: (provider: string) => string | undefined,
): CredentialBinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(config.value);
  } catch {
    return [];
  }

  try {
    const rawBindings = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { bindings?: unknown }).bindings)
        ? (raw as { bindings: unknown[] }).bindings
        : [];

    return rawBindings.flatMap((rawBinding) => {
      const binding = normalizeCredentialBindingsDocument(
        [rawBinding],
        resolveLegacyOAuthProvider,
      )[0];
      if (!binding) return [];
      const bindingProvidedScope =
        rawBinding !== null && typeof rawBinding === "object" && Object.hasOwn(rawBinding, "scope");

      return [
        {
          ...binding,
          scope: bindingProvidedScope
            ? binding.scope
            : (config.scope as CredentialBinding["scope"]),
          scopeId: binding.scopeId ?? config.scopeId ?? null,
        },
      ];
    });
  } catch {
    return [];
  }
}

function bindingHasPlaceholder(binding: CredentialBinding) {
  const placeholder = placeholderForConfigKey(binding.configKey);
  return (
    binding.headerTemplate?.includes(placeholder) === true ||
    binding.queryTemplate?.includes(placeholder) === true
  );
}

export class SwarmConfigCredentialBindingStore implements CredentialBindingStore {
  constructor(
    private readonly readConfigs: ConfigReader,
    private readonly resolveLegacyOAuthProvider?: (provider: string) => string | undefined,
  ) {}

  listActiveBindings(context: CredentialBindingStoreContext): CredentialBinding[] {
    const rows = this.readConfigs({ key: CREDENTIAL_BINDINGS_CONFIG_KEY });
    return rows
      .flatMap((config) => parseBindingsFromConfig(config, this.resolveLegacyOAuthProvider))
      .filter((binding) => binding.active !== false)
      .filter((binding) => appliesToContext(binding, context))
      .filter(bindingHasPlaceholder);
  }
}
