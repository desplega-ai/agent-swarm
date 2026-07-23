import * as z from "zod";

export const CREDENTIAL_BINDINGS_CONFIG_KEY = "SCRIPT_CREDENTIAL_BINDINGS";

export const REDACTED_PLACEHOLDER_PREFIX = "[REDACTED:";

export const CredentialBindingScopeSchema = z.enum(["global", "agent", "repo"]);
export const CredentialBindingAuthKindSchema = z.enum(["config", "oauth"]);

export const CredentialBindingSchema = z
  .object({
    configKey: z.string().min(1).max(255),
    allowedHosts: z.array(z.string().min(1)).min(1),
    headerTemplate: z.string().min(1).optional(),
    queryTemplate: z.string().min(1).optional(),
    scope: CredentialBindingScopeSchema.default("global"),
    scopeId: z.string().nullable().optional(),
    active: z.boolean().default(true),
    authKind: CredentialBindingAuthKindSchema.default("config"),
    oauthAuthorizationId: z.string().min(1).max(255).optional(),
  })
  .refine((binding) => binding.headerTemplate || binding.queryTemplate, {
    message: "At least one of headerTemplate or queryTemplate is required.",
  })
  .refine((binding) => binding.authKind !== "oauth" || !!binding.oauthAuthorizationId, {
    message: "oauthAuthorizationId is required when authKind is oauth.",
    path: ["oauthAuthorizationId"],
  });

export const CredentialBindingsDocumentSchema = z.union([
  z.array(CredentialBindingSchema),
  z.object({ bindings: z.array(CredentialBindingSchema) }),
]);

export type CredentialBindingScope = z.infer<typeof CredentialBindingScopeSchema>;
export type CredentialBindingAuthKind = z.infer<typeof CredentialBindingAuthKindSchema>;
export type CredentialBinding = z.infer<typeof CredentialBindingSchema>;

export type ResolvedCredentialBinding = CredentialBinding & {
  placeholder: string;
  value: string;
};

/**
 * A binding that could not be resolved because its OAuth authorization is in a
 * broken (`refresh-failed`) state. Carried in the sandbox config payload so the
 * patched fetch can throw a typed, actionable error when a request targets the
 * binding's host with its placeholder present — instead of silently leaking the
 * unsubstituted `[REDACTED:...]` placeholder toward the provider (a 401).
 */
export type FailedCredentialBinding = {
  placeholder: string;
  allowedHosts: string[];
  reason: string;
  authorizationLabel?: string;
};

export type CredentialBindingStoreContext = {
  agentId?: string;
  repoId?: string;
};

export interface CredentialBindingStore {
  listActiveBindings(context: CredentialBindingStoreContext): CredentialBinding[];
}

export type CredentialResolver = (configKey: string) => string | undefined;
export type OAuthCredentialResolver = (oauthAuthorizationId: string) => Promise<string | undefined>;

export function placeholderForConfigKey(configKey: string): string {
  return `${REDACTED_PLACEHOLDER_PREFIX}${configKey}]`;
}

export function normalizeCredentialBindingsDocument(
  input: unknown,
  resolveLegacyOAuthProvider?: (provider: string) => string | undefined,
): CredentialBinding[] {
  const document = Array.isArray(input)
    ? input
    : input &&
        typeof input === "object" &&
        Array.isArray((input as { bindings?: unknown }).bindings)
      ? (input as { bindings: unknown[] }).bindings
      : [];

  return document.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const candidate = { ...(raw as Record<string, unknown>) };
    if (
      candidate.authKind === "oauth" &&
      typeof candidate.oauthAuthorizationId !== "string" &&
      typeof candidate.oauthProvider === "string"
    ) {
      const authorizationId = resolveLegacyOAuthProvider?.(candidate.oauthProvider);
      if (!authorizationId) return [];
      candidate.oauthAuthorizationId = authorizationId;
    }
    const parsed = CredentialBindingSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}
