import type {
  CredentialBinding,
  CredentialBindingStore,
  CredentialResolver,
  OAuthCredentialResolver,
} from "./types";
import { placeholderForConfigKey, type ResolvedCredentialBinding } from "./types";

function bindingHasPlaceholder(binding: CredentialBinding) {
  const placeholder = placeholderForConfigKey(binding.configKey);
  return (
    binding.headerTemplate?.includes(placeholder) === true ||
    binding.queryTemplate?.includes(placeholder) === true
  );
}

export class CredentialBroker {
  constructor(
    private readonly store: CredentialBindingStore,
    private readonly resolveConfigCredential: CredentialResolver,
    private readonly defaults: CredentialBinding[] = [],
    private readonly resolveOAuthCredential?: OAuthCredentialResolver,
  ) {}

  async resolveBindings(context: Parameters<CredentialBindingStore["listActiveBindings"]>[0]) {
    const merged = [...this.defaults, ...this.store.listActiveBindings(context)];
    const resolved: ResolvedCredentialBinding[] = [];
    const seen = new Set<string>();

    for (const binding of merged) {
      if (binding.active === false) continue;
      if (!bindingHasPlaceholder(binding)) continue;

      const value =
        binding.authKind === "oauth"
          ? binding.oauthProvider
            ? await this.resolveOAuthCredential?.(binding.oauthProvider)
            : undefined
          : this.resolveConfigCredential(binding.configKey);
      if (!value) continue;

      const dedupeKey = [
        binding.configKey,
        [...binding.allowedHosts].sort().join(","),
        binding.headerTemplate ?? "",
        binding.queryTemplate ?? "",
        binding.scope,
        binding.scopeId ?? "",
      ].join("\0");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      resolved.push({
        ...binding,
        placeholder: placeholderForConfigKey(binding.configKey),
        value,
      });
    }

    return resolved;
  }
}
