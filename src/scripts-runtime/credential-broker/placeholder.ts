// Zod-free on purpose: the native eval harness (`../eval-harness.ts`) reaches
// this through `../script-fs.ts`, and every spawned run parses its whole static
// import graph. `./types.ts` pulls in zod for the binding schemas, which only
// the API side validates; keep the placeholder helpers here so a script that
// never imports zod itself does not pay for loading it.

export const REDACTED_PLACEHOLDER_PREFIX = "[REDACTED:";

export function placeholderForConfigKey(configKey: string): string {
  return `${REDACTED_PLACEHOLDER_PREFIX}${configKey}]`;
}
