/**
 * Recognizes a harness CLI rejecting a model id. Worker-safe (no DB).
 *
 * Claude Code: "There's an issue with the selected model (x). It may not exist
 * or you may not have access to it", or the API's `not_found_error` "model: x".
 * Codex: "The model `x` does not exist or you do not have access to it",
 * "model is not supported", "unknown model".
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

export function isUnknownModelError(text: string | null | undefined): boolean {
  if (!text) return false;
  return UNKNOWN_MODEL_PATTERNS.some((re) => re.test(text));
}
