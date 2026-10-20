// One-line summaries of a node's config, shared by the graph card and the step list.

/** The default `system-one-decision` provider when a node sets none (server: `SYSTEM_ONE_DEFAULT_PROVIDER`). */
const SYSTEM_ONE_DEFAULT_PROVIDER = "typesafe";
/** The default `system-one-extraction` provider (server: `SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER`). */
const SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER = "cloudflare";

/** The workflow a `sub-workflow` node runs, or null when the config names none. */
export function subWorkflowTargetId(config: Record<string, unknown> | undefined): string | null {
  const id = config?.workflowId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** `provider · model` for a `system-one-decision` node. An unset model is the provider default. */
export function systemOneSummary(config: Record<string, unknown> | undefined): string {
  const provider =
    typeof config?.provider === "string" ? config.provider : SYSTEM_ONE_DEFAULT_PROVIDER;
  const model = typeof config?.model === "string" ? config.model : "default model";
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
