// One-line summaries of a node's config, shared by the graph card and the step list.

/** The default `system-one-decision` provider when a node sets none (server: `SYSTEM_ONE_DEFAULT_PROVIDER`). */
const SYSTEM_ONE_DEFAULT_PROVIDER = "typesafe";

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
