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

/**
 * Fold every `<field>Hex` string of a JSON value back into `<field>` (UTF-8)
 * and drop the hex. A hex copy hides a secret from the scrubber, so a sweep
 * decodes it first. Returns the input unchanged when it is not JSON or holds
 * no hex copy.
 */
export function foldHexCopies(value: string): string {
  if (!value.includes('Hex"')) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  let folded = false;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const field = /^(.+)Hex$/.exec(k)?.[1];
      if (field && typeof v === "string" && /^(?:[0-9a-fA-F]{2})*$/.test(v)) {
        obj[field] = Buffer.from(v, "hex").toString("utf8");
        delete obj[k];
        folded = true;
      } else {
        walk(v);
      }
    }
  };
  walk(parsed);
  return folded ? JSON.stringify(parsed) : value;
}
