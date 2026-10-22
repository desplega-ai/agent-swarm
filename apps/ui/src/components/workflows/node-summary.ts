// One-line summaries of a node's config, shared by the graph card and the step list.

/**
 * The `system-one-decision` provider when a node sets none and the
 * `SYSTEM_ONE_DEFAULT_PROVIDER` global config is unset (server: the constant of the same name).
 */
export const SYSTEM_ONE_DEFAULT_PROVIDER = "typesafe";
/** Each decision host's model when a node sets none (server: `SYSTEM_ONE_HOSTS[id].decide.defaultModel`). */
const SYSTEM_ONE_DEFAULT_MODELS: Record<string, string> = {
  typesafe: "jev-latest",
  openrouter: "~typesafe/jev-latest",
  openai: "gpt-6-luna",
  cloudflare: "clef",
};
/** The default `system-one-extraction` provider (server: `SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER`). */
const SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER = "cloudflare";

/** The workflow a `sub-workflow` node runs, or null when the config names none. */
export function subWorkflowTargetId(config: Record<string, unknown> | undefined): string | null {
  const id = config?.workflowId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * `provider · model` for a `system-one-decision` node. An unset provider is
 * `defaultProvider` (the swarm's configured default); an unset model is the provider's.
 */
export function systemOneSummary(
  config: Record<string, unknown> | undefined,
  defaultProvider: string = SYSTEM_ONE_DEFAULT_PROVIDER,
): string {
  const provider = typeof config?.provider === "string" ? config.provider : defaultProvider;
  const model =
    typeof config?.model === "string"
      ? config.model
      : (SYSTEM_ONE_DEFAULT_MODELS[provider] ?? "default model");
  return `${provider} · ${model}`;
}

/** `provider · model · N fields` for a `system-one-extraction` node. */
export function systemOneExtractionSummary(config: Record<string, unknown> | undefined): string {
  const provider =
    typeof config?.provider === "string" ? config.provider : SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER;
  const model = typeof config?.model === "string" ? config.model : "default model";
  const fields = config?.fields;
  const count =
    fields && typeof fields === "object" && !Array.isArray(fields) ? Object.keys(fields).length : 0;
  return `${provider} · ${model} · ${count} ${count === 1 ? "field" : "fields"}`;
}
