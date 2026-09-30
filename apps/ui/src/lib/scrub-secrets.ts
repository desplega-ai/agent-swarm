/**
 * Mask credential-shaped substrings (Bearer tokens, `*_KEY=` assignments, and
 * `aswt_` / `sk-` / `af_` keys) before text reaches the page.
 */
export function scrubSecretText(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:API|TOKEN|SECRET|KEY)[A-Z0-9_]*\s*=\s*)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/\b(aswt_|sk-|af_)[A-Za-z0-9._-]{12,}/g, "$1[REDACTED]");
}
