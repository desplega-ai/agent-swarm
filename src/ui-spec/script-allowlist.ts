/**
 * `UI_SPEC_SCRIPT_ACTIONS`: comma-separated `name@<contentHash prefix>` pins.
 * Pure, so the config guard can validate a value without loading the DB.
 */

export const UI_SPEC_SCRIPT_ACTIONS_KEY = "UI_SPEC_SCRIPT_ACTIONS";

/** A pinned prefix of the script's sha256 `contentHash`: 12 to 64 hex chars. */
const PIN_HASH = /^[0-9a-f]{12,64}$/;

export type ScriptActionPin = { name: string; hashPrefix: string };

export function parseScriptActionAllowlist(raw: string | undefined): {
  pins: ScriptActionPin[];
  issues: string[];
} {
  const pins: ScriptActionPin[] = [];
  const issues: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Split at the last "@", so a name may itself contain one.
    const at = trimmed.lastIndexOf("@");
    const name = at > 0 ? trimmed.slice(0, at).trim() : "";
    const hashPrefix =
      at > 0
        ? trimmed
            .slice(at + 1)
            .trim()
            .toLowerCase()
        : "";
    if (!name || name.length > 200 || !PIN_HASH.test(hashPrefix)) {
      issues.push(
        `"${trimmed}" must be name@<contentHash>, with at least 12 hex chars of the script's contentHash`,
      );
      continue;
    }
    pins.push({ name, hashPrefix });
  }
  return { pins, issues };
}

/** The `VALIDATED_KEYS` validator for `UI_SPEC_SCRIPT_ACTIONS`. */
export function validateScriptActionAllowlist(value: unknown): string | null {
  if (typeof value !== "string") return "UI_SPEC_SCRIPT_ACTIONS must be a string";
  const { issues } = parseScriptActionAllowlist(value);
  return issues.length > 0 ? `UI_SPEC_SCRIPT_ACTIONS: ${issues.join("; ")}` : null;
}
