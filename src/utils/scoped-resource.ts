import { z } from "zod";

export type ScopedResourceScope = "global" | "agent" | "repo";

export const scopedResourceScopeIdSchema = z.string().min(1).max(255);

const agentScopeIdSchema = z.string().uuid();

export function resolveScopedResourceId(
  scope: ScopedResourceScope | undefined,
  scopeId: string | null | undefined,
  subject: string,
): string | null {
  if (!scope || scope === "global") return null;
  if (!scopeId || scopeId.trim().length === 0) {
    throw new Error(`scopeId is required for ${scope} ${subject}.`);
  }
  if (scopeId.length > 255) {
    throw new Error(`scopeId must be at most 255 characters for ${scope} ${subject}.`);
  }
  if (scope === "agent" && !agentScopeIdSchema.safeParse(scopeId).success) {
    throw new Error(`scopeId must be an agent UUID for agent ${subject}.`);
  }
  return scopeId;
}
