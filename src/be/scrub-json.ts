import { type ScrubbedText, scrubObject, scrubSecrets } from "../utils/secret-scrubber";

/** True when `before` parsed as JSON and `after` no longer does. */
export function breaksJsonValidity(before: string, after: string): boolean {
  try {
    JSON.parse(before);
  } catch {
    return false;
  }
  try {
    JSON.parse(after);
    return false;
  } catch {
    return true;
  }
}

/**
 * Serialize `value` for a JSON TEXT column with secrets redacted.
 *
 * Scrubs the serialized text first, so context-keyed passes (`"password":
 * "..."`, auth headers) see the key next to its value. When a redaction breaks
 * JSON validity (a marker swallowed a quote or brace), falls back to scrubbing
 * each string leaf, which always serializes cleanly. Readers keep `JSON.parse`.
 */
export function scrubJsonValue(value: unknown): ScrubbedText {
  const raw = JSON.stringify(value);
  const scrubbed = scrubSecrets(raw);
  if (!breaksJsonValidity(raw, scrubbed)) return scrubbed;
  // Every string leaf went through scrubSecrets; the brand holds.
  return JSON.stringify(scrubObject(value)) as ScrubbedText;
}
