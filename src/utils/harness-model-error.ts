/**
 * Recognizes a harness CLI rejecting a model id. Worker-safe (no DB).
 *
 * Claude Code: "There's an issue with the selected model (x). It may not exist
 * or you may not have access to it", or the API's `not_found_error` "model: x".
 * Codex: "The model `x` does not exist or you do not have access to it",
 * "model is not supported", "unknown model".
 *
 * A model-rejection phrase can also appear in an unrelated failure ("invalid model output"),
 * and a false positive marks the model unsupported for the whole (harness, CLI version). So
 * when `modelId` is given, the rejection line must name that model.
 */
const UNKNOWN_MODEL_PATTERNS: RegExp[] = [
  /issue with the selected model/i,
  /model[`'" ]*[\w.:/-]*[`'" ]*(?:does not exist|not found)/i,
  /not_found_error[^\n]*model/i,
  /model[^\n]{0,80}is not supported/i,
  /unsupported model/i,
  /unknown model/i,
  /invalid model/i,
];

export function isUnknownModelError(
  text: string | null | undefined,
  modelId?: string | null,
): boolean {
  if (!text) return false;
  const id = modelId?.trim().toLowerCase();
  return text.split("\n").some((line) => {
    if (!UNKNOWN_MODEL_PATTERNS.some((re) => re.test(line))) return false;
    return !id || line.toLowerCase().includes(id);
  });
}
