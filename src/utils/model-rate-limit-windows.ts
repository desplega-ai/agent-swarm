/**
 * Vocabulary for the Claude Code CLI's model-scoped weekly rate-limit windows.
 * Pure module: no `src/be` import, no env read. Safe for worker and server code.
 *
 * CLI 2.1.280 label table (`rateLimitType` -> operator-facing label), copied from
 * the CLI binary at `/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`:
 *   five_hour: "session limit"
 *   seven_day: "weekly limit"
 *   seven_day_opus: "Opus limit"
 *   seven_day_sonnet: "Sonnet limit"
 *   seven_day_overage_included: "Fable limit"
 *   overage: "usage credit limit"
 * The CLI's own type name for the Fable window does not contain the word
 * "Fable" — the constant name here is what makes it legible.
 */
export const FABLE_WINDOW = "seven_day_overage_included";
export const OPUS_WINDOW = "seven_day_opus";
export const SONNET_WINDOW = "seven_day_sonnet";

/** rateLimitType values that scope a rejection to one model family, not the whole key. */
export const MODEL_SCOPED_WINDOWS: Record<string, ModelFamily> = {
  [FABLE_WINDOW]: "fable",
  [OPUS_WINDOW]: "opus",
  [SONNET_WINDOW]: "sonnet",
};

/** rateLimitType values that block the whole key (legacy path, unchanged). */
export const KEY_WIDE_WINDOWS = ["five_hour", "seven_day", "overage"] as const;

export type ModelFamily = "fable" | "opus" | "sonnet" | "haiku";

/**
 * Detects the model family from a model string, ignoring version, date,
 * context-size and provider-prefix parts. Checked in this order so the first
 * matching family name wins: fable, opus, sonnet, haiku.
 */
export function modelFamilyOf(model: string | undefined): ModelFamily | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  const families: ModelFamily[] = ["fable", "opus", "sonnet", "haiku"];
  for (const family of families) {
    if (lower.includes(family)) return family;
  }
  return undefined;
}

/** Inverse of MODEL_SCOPED_WINDOWS. `haiku` has no weekly window in the CLI enum. */
export function windowForModelFamily(family: ModelFamily): string | undefined {
  switch (family) {
    case "fable":
      return FABLE_WINDOW;
    case "opus":
      return OPUS_WINDOW;
    case "sonnet":
      return SONNET_WINDOW;
    default:
      return undefined;
  }
}

export function isModelScopedWindow(type: string): boolean {
  return Object.hasOwn(MODEL_SCOPED_WINDOWS, type) && MODEL_SCOPED_WINDOWS[type] !== undefined;
}

/**
 * Text fallback for when no structured rate_limit_event arrives. Matches the
 * CLI's failure text, e.g. "You've reached your Fable limit. Switch to
 * another model to continue."
 */
export function parseModelLimitMessage(text: string): ModelFamily | undefined {
  const match = text.match(/reached your (Fable|Opus|Sonnet) limit/i);
  if (!match) return undefined;
  return match[1]!.toLowerCase() as ModelFamily;
}

interface RateLimitWindowLike {
  status: string;
  resetsAt?: number;
}

/**
 * Returns the active rejected window for a model family, or undefined when
 * the family has no window, no entry, a non-rejected status, or an
 * already-passed resetsAt.
 */
export function activeModelBlock(
  windows: Record<string, RateLimitWindowLike> | undefined,
  family: ModelFamily,
  nowMs: number,
): { window: string; resetsAt: number } | undefined {
  if (!windows) return undefined;
  const window = windowForModelFamily(family);
  if (!window) return undefined;
  const entry = windows[window];
  if (!entry) return undefined;
  if (entry.status !== "rejected") return undefined;
  if (typeof entry.resetsAt !== "number" || entry.resetsAt * 1000 <= nowMs) return undefined;
  return { window, resetsAt: entry.resetsAt };
}

/** Every model family with an active rejected window, in MODEL_SCOPED_WINDOWS order. */
export function activeModelBlocks(
  windows: Record<string, RateLimitWindowLike> | undefined,
  nowMs: number,
): Array<{ model: ModelFamily; window: string; resetsAt: number }> {
  if (!windows) return [];
  const blocks: Array<{ model: ModelFamily; window: string; resetsAt: number }> = [];
  for (const [window, model] of Object.entries(MODEL_SCOPED_WINDOWS)) {
    const entry = windows[window];
    if (!entry) continue;
    if (entry.status !== "rejected") continue;
    if (typeof entry.resetsAt !== "number" || entry.resetsAt * 1000 <= nowMs) continue;
    blocks.push({ model, window, resetsAt: entry.resetsAt });
  }
  return blocks;
}
