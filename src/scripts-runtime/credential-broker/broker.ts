import type {
  CredentialBinding,
  CredentialBindingStore,
  CredentialResolver,
  FailedCredentialBinding,
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

function reasonFromError(err: unknown): string {
  const reason = (err as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : "refresh_failed";
}

function labelFromError(err: unknown): string | undefined {
  const label = (err as { authorizationLabel?: unknown }).authorizationLabel;
  return typeof label === "string" && label.length > 0 ? label : undefined;
}

export class CredentialBroker {
  constructor(
    private readonly store: CredentialBindingStore,
    private readonly resolveConfigCredential: CredentialResolver,
    private readonly defaults: CredentialBinding[] = [],
    private readonly resolveOAuthCredential?: OAuthCredentialResolver,
  ) {}

  /**
   * Resolve all active bindings, partitioning them into successfully-resolved
   * entries and OAuth bindings whose refresh failed. The OAuth resolver may
   * THROW (e.g. OAuthRefreshError) to signal a genuine refresh failure — that
   * becomes a {@link FailedCredentialBinding}; returning `undefined` means
   * genuinely-missing and is silently skipped (matching config bindings).
   */
  async resolveBindingsWithFailures(
    context: Parameters<CredentialBindingStore["listActiveBindings"]>[0],
  ): Promise<{ resolved: ResolvedCredentialBinding[]; failed: FailedCredentialBinding[] }> {
    const merged = [...this.defaults, ...this.store.listActiveBindings(context)];
    const resolved: ResolvedCredentialBinding[] = [];
    const failed: FailedCredentialBinding[] = [];
    const seen = new Set<string>();
    const failedSeen = new Set<string>();

    for (const binding of merged) {
      if (binding.active === false) continue;
      if (!bindingHasPlaceholder(binding)) continue;

      let value: string | undefined;
      if (binding.authKind === "oauth") {
        if (!binding.oauthAuthorizationId) continue;
        try {
          value = await this.resolveOAuthCredential?.(binding.oauthAuthorizationId);
        } catch (err) {
          const placeholder = placeholderForConfigKey(binding.configKey);
          const failKey = [placeholder, [...binding.allowedHosts].sort().join(",")].join("\0");
          if (!failedSeen.has(failKey)) {
            failedSeen.add(failKey);
            const label = labelFromError(err);
            failed.push({
              placeholder,
              allowedHosts: binding.allowedHosts,
              reason: reasonFromError(err),
              ...(label ? { authorizationLabel: label } : {}),
            });
          }
          continue;
        }
      } else {
        value = this.resolveConfigCredential(binding.configKey);
      }
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

    return { resolved, failed };
  }

  async resolveBindings(context: Parameters<CredentialBindingStore["listActiveBindings"]>[0]) {
    return (await this.resolveBindingsWithFailures(context)).resolved;
  }
}
