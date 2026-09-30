import {
  type ParsedAlias as CatalogParsedAlias,
  parseAlias as parseCatalogAlias,
  resolveAlias as resolveCatalogAlias,
} from "@desplega/model-catalog";
import type { HarnessConfig } from "../types.ts";
import type { ModelsDevCatalog } from "./catalog.ts";

/**
 * Moving model aliases for harness configs (`HarnessConfig.modelAlias`).
 *
 * Parsing + resolution live in `@desplega/model-catalog`. Evals accepts only
 * the subset it has always accepted: `latest:anthropic/<family>` and
 * `latest:openrouter/<glob>`, with no `@channel` suffix. That subset resolves
 * exactly as before (default `@stable` channel, no soak). Newer grammar
 * (`latest:openai/...`, `@stable`/`@any`) is rejected here so eval configs keep
 * their current behavior.
 */

export type ParsedAlias = Extract<CatalogParsedAlias, { kind: "anthropic" | "openrouter" }>;

/** Parse an alias string; null when it is not valid evals grammar. */
export function parseAlias(alias: string): ParsedAlias | null {
  if (alias.includes("@")) return null;
  const parsed = parseCatalogAlias(alias);
  if (!parsed || parsed.kind === "openai") return null;
  return parsed;
}

/** Resolve an alias to a concrete MODEL_OVERRIDE id; null when nothing matches. */
export function resolveAlias(alias: string, catalog: ModelsDevCatalog): string | null {
  if (!parseAlias(alias)) return null;
  return resolveCatalogAlias(alias, catalog);
}

/** Config shape errors: `model` and `modelAlias` are mutually exclusive, and the alias must parse. */
export function validateConfigModel(config: HarnessConfig): string[] {
  const errors: string[] = [];
  if (config.model !== undefined && config.modelAlias !== undefined) {
    errors.push("sets both model and modelAlias; pick one");
  }
  if (config.modelAlias !== undefined) {
    const parsed = parseAlias(config.modelAlias);
    if (!parsed) errors.push(`modelAlias "${config.modelAlias}" is not valid alias grammar`);
    else if (parsed.kind === "anthropic" && config.provider !== "claude") {
      errors.push(`modelAlias "${config.modelAlias}" needs provider claude`);
    } else if (
      parsed.kind === "openrouter" &&
      config.provider !== "pi" &&
      config.provider !== "opencode"
    ) {
      errors.push(`modelAlias "${config.modelAlias}" needs provider pi or opencode`);
    }
  }
  return errors;
}

/**
 * Read-time fallback for rows written before resolved models were recorded:
 * `latest:anthropic/opus` → the bare "opus" the harness used to receive, which
 * the analytics alias map then resolves like any historical bare alias.
 */
export function legacyAliasModel(alias: string): string | null {
  const parsed = parseAlias(alias);
  return parsed?.kind === "anthropic" ? parsed.family : null;
}

/** models.dev section each harness provider's `model` ids come from. */
const PROVIDER_SECTION: Record<HarnessConfig["provider"], string> = {
  claude: "anthropic",
  codex: "openai",
  pi: "openrouter",
  opencode: "openrouter",
};

/**
 * Save-time check for configs created or edited through the API: the pinned
 * `model` must be an id in the provider's catalog section, and a `modelAlias`
 * must resolve to something today. Pass getResolutionCatalog(), so both checks
 * use the same reviewed ID set as run-time alias resolution. Returns errors.
 */
export function validateConfigResolves(config: HarnessConfig, catalog: ModelsDevCatalog): string[] {
  const errors = validateConfigModel(config);
  if (errors.length > 0) return errors;
  if (config.model === undefined && config.modelAlias === undefined) {
    return ["set either model or modelAlias"];
  }
  if (config.modelAlias !== undefined) {
    if (!resolveAlias(config.modelAlias, catalog)) {
      errors.push(`modelAlias "${config.modelAlias}" matches no model in the catalog`);
    }
    return errors;
  }
  const model = config.model ?? "";
  const section = PROVIDER_SECTION[config.provider];
  let id = model;
  if (section === "openrouter") {
    if (!model.startsWith("openrouter/")) {
      return [`model "${model}" must start with "openrouter/" for provider ${config.provider}`];
    }
    id = model.slice("openrouter/".length);
  }
  if (!catalog[section]?.models?.[id]) {
    errors.push(`model "${model}" is not in the ${section} catalog`);
  }
  return errors;
}
