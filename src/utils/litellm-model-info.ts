import { type ModelLimits, positiveTokenLimit } from "./provider-model-limits";

export const MAX_MODEL_INFO_ROWS = 10000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Only selected-alias facts survive parsing. max_tokens has no combined-context semantics. */
export function parseLiteLLMModelInfo(body: unknown, modelId: string): ModelLimits | undefined {
  const data = record(body)?.data;
  if (!Array.isArray(data) || data.length > MAX_MODEL_INFO_ROWS) {
    throw new Error("Invalid model metadata envelope");
  }
  const deployments = data.map(record).filter((row) => row?.model_name === modelId);
  if (!deployments.length) return undefined;
  const bounds: ModelLimits = {};
  for (const [field, key] of [
    ["input", "max_input_tokens"],
    ["output", "max_output_tokens"],
  ] as const) {
    const values = deployments.map((row) => {
      const info = record(row?.model_info);
      return info?.mode === undefined || info.mode === "chat" ? info?.[key] : undefined;
    });
    if (values.every(positiveTokenLimit)) bounds[field] = Math.min(...values);
  }
  // No combined field is universally documented by LiteLLM. An operator can supply
  // one explicitly; supporting a versioned metadata field needs its own contract.
  return Object.keys(bounds).length ? bounds : undefined;
}
