import * as z from "zod";

export const CREDENTIAL_BINDINGS_CONFIG_KEY = "SCRIPT_CREDENTIAL_BINDINGS";

export const REDACTED_PLACEHOLDER_PREFIX = "[REDACTED:";

export const CredentialBindingScopeSchema = z.enum(["global", "agent", "repo"]);

export const CredentialBindingSchema = z
  .object({
    configKey: z.string().min(1).max(255),
    allowedHosts: z.array(z.string().min(1)).min(1),
    headerTemplate: z.string().min(1).optional(),
    queryTemplate: z.string().min(1).optional(),
    scope: CredentialBindingScopeSchema.default("global"),
    scopeId: z.string().nullable().optional(),
    active: z.boolean().default(true),
  })
  .refine((binding) => binding.headerTemplate || binding.queryTemplate, {
    message: "At least one of headerTemplate or queryTemplate is required.",
  });

export const CredentialBindingsDocumentSchema = z.union([
  z.array(CredentialBindingSchema),
  z.object({ bindings: z.array(CredentialBindingSchema) }),
]);

export type CredentialBindingScope = z.infer<typeof CredentialBindingScopeSchema>;
export type CredentialBinding = z.infer<typeof CredentialBindingSchema>;

export type ResolvedCredentialBinding = CredentialBinding & {
  placeholder: string;
  value: string;
};

export type CredentialBindingStoreContext = {
  agentId?: string;
  repoId?: string;
};

export interface CredentialBindingStore {
  listActiveBindings(context: CredentialBindingStoreContext): CredentialBinding[];
}

export type CredentialResolver = (configKey: string) => string | undefined;

export function placeholderForConfigKey(configKey: string): string {
  return `${REDACTED_PLACEHOLDER_PREFIX}${configKey}]`;
}

export function normalizeCredentialBindingsDocument(input: unknown): CredentialBinding[] {
  const parsed = CredentialBindingsDocumentSchema.parse(input);
  return Array.isArray(parsed) ? parsed : parsed.bindings;
}
