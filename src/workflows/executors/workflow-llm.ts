import { providerBaseUrl, providerForModel, providerKeyVars } from "@desplega/model-catalog";
import { selectCredential } from "../../utils/credentials";
import { DEFAULT_MODEL, resolveCredential } from "../../utils/internal-ai/credentials";
import {
  getOpenRouterAttributionHeaders,
  getOpenRouterBaseUrl,
} from "../../utils/openrouter-base-url";

export interface WorkflowLlmConfig {
  apiKey: string;
  baseURL?: string;
  /** OpenRouter app attribution; empty for OpenAI and for gateway base URLs. */
  headers: Record<string, string>;
  model: string;
}

/**
 * Resolve an OpenAI-compatible credential and endpoint for workflow LLM nodes.
 *
 * `requireKind` is for callers that must talk to one specific provider: the
 * resolver picks by precedence (OpenRouter, then Anthropic, then OpenAI), so a
 * caller that needs the OpenRouter key would otherwise be handed an OpenAI key
 * whenever the OpenRouter one is absent.
 */
export async function resolveWorkflowLlmConfig(
  requestedModel?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { requireKind?: "openrouter" | "openai" } = {},
): Promise<WorkflowLlmConfig> {
  // `nan/<model>`, `helmcode/<model>`, ...: an OpenAI-compatible registry
  // provider is reached with its own key and base URL, never through OpenRouter.
  const registryProvider = options.requireKind ? undefined : providerForModel(requestedModel);
  if (registryProvider && requestedModel) {
    const keyVar = providerKeyVars(registryProvider).find((name) => env[name]?.trim());
    if (!keyVar) {
      throw new Error(
        `No ${registryProvider.displayName} credential found for ${requestedModel}. Set ${registryProvider.envVar}.`,
      );
    }
    return {
      // The API hydrates global config verbatim, so a key may still be a
      // comma pool; workflow calls skip the runner's per-task pick.
      apiKey: selectCredential(env[keyVar] as string, undefined, keyVar).selected,
      baseURL: providerBaseUrl(registryProvider, env),
      headers: {},
      model: requestedModel.slice(registryProvider.id.length + 1),
    };
  }

  const credential = await resolveCredential({ env });
  if (!credential) {
    throw new Error("No workflow LLM credential found. Set OPENROUTER_API_KEY or OPENAI_API_KEY.");
  }

  if (options.requireKind && credential.kind !== options.requireKind) {
    throw new Error(`No ${options.requireKind} credential found for this workflow LLM call.`);
  }

  if (credential.kind !== "openrouter" && credential.kind !== "openai") {
    throw new Error(
      `Workflow LLM nodes do not support the resolved ${credential.kind} credential yet. Set OPENROUTER_API_KEY or OPENAI_API_KEY.`,
    );
  }

  const providerPrefix = `${credential.kind}/`;
  // Workflow defaults are provider-owned; MEMORY_RATER_MODEL only configures memory work.
  const model = requestedModel ?? DEFAULT_MODEL[credential.kind];

  const baseURL = credential.kind === "openrouter" ? getOpenRouterBaseUrl(env) : undefined;
  return {
    apiKey: credential.apiKey,
    baseURL,
    headers: baseURL ? getOpenRouterAttributionHeaders(baseURL, env) : {},
    model: model.startsWith(providerPrefix) ? model.slice(providerPrefix.length) : model,
  };
}
