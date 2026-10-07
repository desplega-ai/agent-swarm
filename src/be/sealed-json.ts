import { decryptSecret, encryptSecret, getEncryptionKey } from "./crypto";
import { scrubJsonValue } from "./scrub-json";

/**
 * Sealed JSON: byte-exact replay state, encrypted at rest.
 *
 * Some JSON columns are execution inputs, not records. The supervisor relaunches
 * a durable script run from `script_runs.args`, and the harness replays
 * `script_run_journal.result` as a step's return value. Redacting them would
 * change what the script sees after a restart, and storing them raw leaves a
 * secret at rest. Sealing keeps the exact bytes for the replay readers and
 * nothing readable for anything that scans the database.
 *
 * Readers pick a view: `openSealedJson` (replay, exact value) or
 * `sealedJsonForDisplay` (API/UI, redacted). Rows written before sealing are
 * plain JSON and both readers still accept them.
 */

const SEALED_PREFIX = "sealed:v1:";

export function sealJson(value: unknown): string {
  return SEALED_PREFIX + encryptSecret(JSON.stringify(value), getEncryptionKey());
}

export function isSealedJson(text: string): boolean {
  return text.startsWith(SEALED_PREFIX);
}

/** The exact stored value. Only execution and replay paths may call this. */
export function openSealedJson(text: string): unknown {
  if (!isSealedJson(text)) return JSON.parse(text);
  return JSON.parse(decryptSecret(text.slice(SEALED_PREFIX.length), getEncryptionKey()));
}

/** The stored value with secrets redacted, for API responses and the UI. */
export function sealedJsonForDisplay(text: string): unknown {
  return JSON.parse(scrubJsonValue(openSealedJson(text)));
}
