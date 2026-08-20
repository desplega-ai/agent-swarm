import type { User, UserCommsPrefs } from "../types";

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Extract structured communication preferences from `users.metadata.comms`.
 * `metadata` is a free-form JSON blob with no write-side validation, so only
 * non-empty string fields survive; returns undefined when nothing usable is set.
 */
export function getUserCommsPrefs(
  user: Pick<User, "metadata"> | null | undefined,
): UserCommsPrefs | undefined {
  const comms = user?.metadata?.comms;
  if (!comms || typeof comms !== "object" || Array.isArray(comms)) return undefined;
  const record = comms as Record<string, unknown>;
  const prefs: UserCommsPrefs = {
    tone: pickString(record.tone),
    language: pickString(record.language),
    verbosity: pickString(record.verbosity),
  };
  return prefs.tone || prefs.language || prefs.verbosity ? prefs : undefined;
}
