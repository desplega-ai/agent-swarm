/**
 * Model strings the `amp` harness accepts. Pure, so the API server can validate
 * a task or agent `model` without importing the worker-side adapter.
 *
 * Amp has no model flag. The per-task plugin agent runs a `provider/model`:
 * the pin, else the model of the selected mode (AMP_MODE_MODELS).
 */
import { DEFAULT_MODEL_TIER_MAP } from "../types";

/** Amp's built-in modes. `low` is the cheapest (GLM-5.3 Flash when verified live). */
export const AMP_MODES = ["low", "medium", "high", "ultra"] as const;
export type AmpMode = (typeof AMP_MODES)[number];

/**
 * The model a session's cost is estimated at when `amp threads export` returns
 * nothing (a cancelled thread can lag behind on the server or never reach it).
 * Each is the agent model Amp ran for that mode, read from
 * `amp threads usage --details` on 2026-10-05 and matching ampcode.com/modes:
 * low GLM-5.3 Flash, medium Claude Opus 5.5, high GPT-6 Astra, ultra Claude
 * Fable 5.1. Amp re-routes modes as models change; re-measure on a CLI bump.
 */
export const AMP_ESTIMATE_MODELS: Readonly<Record<AmpMode, string>> = {
  low: "accounts/fireworks/models/glm-5p3-flash",
  medium: "claude-opus-5-5",
  high: "gpt-6-astra",
  ultra: "claude-fable-5-1",
};

/** Anthropic bills prompt-cache writes; every other vendor's cache-creation count is plain input. */
export function ampBillsCacheWrites(model: string): boolean {
  return /^(anthropic\/)?claude/i.test(model);
}

/**
 * The plugin agent's model for each mode. Amp's CLI (live on 0.0.1795060840)
 * requires a plugin agent to name a `provider/model` (`extends` throws, and a plugin
 * mode cannot wrap a built-in mode), so a mode runs the model Amp ran for it
 * (the AMP_ESTIMATE_MODELS measurement), with that model's own prompt and tools.
 */
export const AMP_MODE_MODELS: Readonly<Record<AmpMode, string>> = {
  low: "zhipuai/glm-5.3-flash",
  medium: "anthropic/claude-opus-5-5",
  high: "openai/gpt-6-astra",
  ultra: "anthropic/claude-fable-5-1",
};

/** Amp's plugin agents default to `medium` effort, which GLM-5.3 Flash rejects (low, high, max). */
export const AMP_MODE_EFFORTS: Readonly<Partial<Record<AmpMode, string>>> = { low: "low" };

/** The mode a pinned model is reported and cost-estimated under. */
export const AMP_PIN_BASE_MODE: AmpMode = "medium";

/** `provider/model`, the form Amp's plugin agents take (`openai/gpt-5-nano`). */
const AMP_PIN_RE = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export interface AmpModelSelection {
  /** The model string as stored on the task: a mode or `provider/model`. */
  model: string;
  /** The built-in mode the session is reported under; without a pin, its model runs. */
  baseMode: AmpMode;
  /** The pinned `provider/model`, when the task named a concrete model. */
  pin?: string;
}

/**
 * Providers Amp accepts in a pin, measured against the pinned CLI on
 * 2026-10-05. Any other provider fails inside Amp ("Unknown model provider:
 * google", "No actor inference facet for provider: deepseek"), but only after
 * the task has started, so send-task rejects it first. Re-measure on a CLI bump.
 */
export const AMP_PIN_PROVIDERS = [
  "anthropic",
  "openai",
  "vertexai",
  "xai",
  "fireworks",
  "baseten",
] as const;

/** Pin providers whose model ids are the catalog section of the same name. */
const AMP_CATALOG_CHECKED_PROVIDERS = new Set(["anthropic", "openai"]);

type CatalogSections = Record<string, { models?: Record<string, unknown> } | undefined>;

function splitPin(model: string): { value: string; provider: string; id: string } | null {
  const value = model.trim();
  const slash = value.indexOf("/");
  return slash < 0 ? null : { value, provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** Null for a mode or a pin whose provider Amp runs, else the reason. Pure. */
export function ampPinProviderError(model: string): string | null {
  const pin = splitPin(model);
  if (!pin || (AMP_PIN_PROVIDERS as readonly string[]).includes(pin.provider)) return null;
  return `Unknown amp model provider "${pin.provider}" in "${pin.value}". Amp runs pins from ${AMP_PIN_PROVIDERS.join(", ")}, or use a mode (${AMP_MODES.join(", ")}). If Amp has added this provider, set allowCustomModel: true.`;
}

/**
 * Null unless an anthropic or openai pin names a model the catalog lacks (Amp
 * answers "Model is not supported" for it once the task runs). An empty
 * catalog section passes. Pure.
 */
export function ampPinCatalogError(model: string, catalog: CatalogSections): string | null {
  const pin = splitPin(model);
  if (!pin || !AMP_CATALOG_CHECKED_PROVIDERS.has(pin.provider)) return null;
  const models = catalog[pin.provider]?.models;
  if (!models || Object.hasOwn(models, pin.id)) return null;
  return `Unknown amp model "${pin.value}": ${pin.provider} has no model "${pin.id}" in the model catalog. To run it anyway, set allowCustomModel: true.`;
}

/** The reason `model` is not an amp model, or null when it is one. */
export function ampModelError(model: string): string | null {
  const value = model.trim();
  if ((AMP_MODES as readonly string[]).includes(value.toLowerCase()) || AMP_PIN_RE.test(value)) {
    return null;
  }
  return `Unsupported amp model "${value}". Use a mode (${AMP_MODES.join(", ")}) or a provider/model id such as anthropic/claude-haiku-4-5-20251001.`;
}

/** Resolve a task's model for amp. An empty value means the regular tier. Throws on anything else Amp cannot run. */
export function resolveAmpModel(model: string | undefined): AmpModelSelection {
  const value = (model || DEFAULT_MODEL_TIER_MAP.amp.regular).trim();
  const error = ampModelError(value);
  if (error) throw new Error(error);
  const mode = value.toLowerCase();
  if ((AMP_MODES as readonly string[]).includes(mode)) {
    return { model: mode, baseMode: mode as AmpMode };
  }
  return { model: value, baseMode: AMP_PIN_BASE_MODE, pin: value };
}
