import type { ComponentType } from "react";
import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import type { SwarmConfig } from "@/api/types";
import { ClaudeManagedSection } from "@/components/integrations/claude-managed-section";
import { CodexOAuthSection } from "@/components/integrations/codex-oauth-section";
import { JiraOAuthSection } from "@/components/integrations/jira-oauth-section";
import { LinearOAuthSection } from "@/components/integrations/linear-oauth-section";
import { MemoryEmbeddingsSection } from "@/components/integrations/memory-embeddings-section";
import type { IntegrationDef, IntegrationSpecialFlow } from "@/lib/integrations-catalog";

export interface SpecialFlowSectionProps {
  def: IntegrationDef;
  configs: SwarmConfig[];
  envPresence: EnvPresenceMap;
}

/**
 * How the generic catalog form renders next to a special flow's section:
 * - `shown`: below the section, as usual.
 * - `advanced`: the section edits the same keys, so the generic form sits
 *   in a collapsed Advanced disclosure and each key is visible once.
 * - `replaced`: the section is the whole body; no generic form, no save bar.
 */
export type GenericFieldsMode = "shown" | "advanced" | "replaced";

export interface SpecialFlow {
  Section: ComponentType<SpecialFlowSectionProps>;
  genericFields: GenericFieldsMode;
}

/** Keyed by the union, so a new flow without an entry fails the type check. */
export const SPECIAL_FLOWS: Record<IntegrationSpecialFlow, SpecialFlow> = {
  "linear-oauth": { Section: LinearOAuthSection, genericFields: "shown" },
  "jira-oauth": { Section: JiraOAuthSection, genericFields: "shown" },
  "claude-managed-cli": { Section: ClaudeManagedSection, genericFields: "shown" },
  "codex-cli": { Section: CodexOAuthSection, genericFields: "replaced" },
  "memory-embeddings": { Section: MemoryEmbeddingsSection, genericFields: "advanced" },
};
