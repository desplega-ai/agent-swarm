/**
 * Synthetic secrets for scrubber regression tests.
 *
 * Values are built at runtime from random bytes, never written as literals,
 * so repo secret scanners and GitHub push protection never flag a fixture.
 */
import { randomBytes } from "node:crypto";
import { clearVolatileSecretsForTesting, registerVolatileSecret } from "../utils/secret-scrubber";

export interface SyntheticSecret {
  /** The runtime-built secret value. Never log it outside an assertion. */
  value: string;
  /** The name the scrubber reports in its `[REDACTED:<name>]` marker. */
  name: string;
  /** Drop every volatile secret registered for this test file. */
  cleanup: () => void;
}

/** A random alphanumeric string of `len` chars (base64url minus `-`/`_`). */
export function randomToken(len = 32): string {
  let out = "";
  while (out.length < len) {
    out += randomBytes(len).toString("base64url").replace(/[-_]/g, "");
  }
  return out.slice(0, len);
}

/**
 * Build a high-entropy value and register it with the scrubber's known-value
 * pass, the same path a runtime-fetched credential takes.
 */
export function syntheticSecret(prefix = "canary", len = 32): SyntheticSecret {
  const value = [prefix, randomToken(len)].join("_");
  const name = `SYNTHETIC_${prefix.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SECRET`;
  registerVolatileSecret(value, name);
  return { value, name, cleanup: clearVolatileSecretsForTesting };
}
