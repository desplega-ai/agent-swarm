import { DEFAULT_MODEL, resolveCredential } from "../../utils/internal-ai/credentials";
import { getOpenRouterBaseUrl } from "../../utils/openrouter-base-url";

export interface WorkflowLlmConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

/** Resolve an OpenAI-compatible credential and endpoint for workflow LLM nodes. */
export async function resolveWorkflowLlmConfig(
  requestedModel?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowLlmConfig> {
  const credential = await resolveCredential({ env });
  if (!credential) {
    throw new Error("No workflow LLM credential found. Set OPENROUTER_API_KEY or OPENAI_API_KEY.");
  }

  if (credential.kind !== "openrouter" && credential.kind !== "openai") {
    throw new Error(
      `Workflow LLM nodes do not support the resolved ${credential.kind} credential yet. Set OPENROUTER_API_KEY or OPENAI_API_KEY.`,
    );
  }

  const providerPrefix = `${credential.kind}/`;
  // Workflow defaults are provider-owned; MEMORY_RATER_MODEL only configures memory work.
  const model = requestedModel ?? DEFAULT_MODEL[credential.kind];

  return {
    apiKey: credential.apiKey,
    baseURL: credential.kind === "openrouter" ? getOpenRouterBaseUrl(env) : undefined,
    model: model.startsWith(providerPrefix) ? model.slice(providerPrefix.length) : model,
  };
}
