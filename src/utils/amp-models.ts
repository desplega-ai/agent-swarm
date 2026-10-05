/**
 * Model strings the `amp` harness accepts. Pure, so the API server can validate
 * a task or agent `model` without importing the worker-side adapter.
 *
 * Amp has no model flag. A mode lets Amp choose the model server-side; a
 * `provider/model` id pins one through the per-task plugin agent.
 */
import { DEFAULT_MODEL_TIER_MAP } from "../types";

/** Amp's built-in modes. `low` is the cheapest (GLM-5.3 Flash when verified live). */
export const AMP_MODES = ["low", "medium", "high", "ultra"] as const;
export type AmpMode = (typeof AMP_MODES)[number];

/**
 * The model a session's cost is estimated at when `amp threads export` returns
 * nothing (a cancelled thread can lag behind on the server or never reach it).
 * Measured 2026-10-05: `low` ran GLM-5.3 Flash and `medium` ran Claude Opus 5.5.
 * `high` and `ultra` were not measured and are assumed no cheaper than `medium`.
 */
export const AMP_ESTIMATE_MODELS: Readonly<Record<AmpMode, string>> = {
  low: "accounts/fireworks/models/glm-5p3-flash",
  medium: "claude-opus-5-5",
  high: "claude-opus-5-5",
  ultra: "claude-opus-5-5",
};

/** Anthropic bills prompt-cache writes; every other vendor's cache-creation count is plain input. */
export function ampBillsCacheWrites(model: string): boolean {
  return /^(anthropic\/)?claude/i.test(model);
}

/** A pinned model runs on top of this built-in mode's prompt and tools. */
export const AMP_PIN_BASE_MODE: AmpMode = "medium";

/** `provider/model`, the form Amp's plugin agents take (`openai/gpt-5-nano`). */
const AMP_PIN_RE = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export interface AmpModelSelection {
  /** The model string as stored on the task: a mode or `provider/model`. */
  model: string;
  /** The built-in mode whose prompt and tools the session runs on. */
  baseMode: AmpMode;
  /** The pinned `provider/model`, when the task named a concrete model. */
  pin?: string;
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
