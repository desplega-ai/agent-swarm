import { getTaskUiSpec } from "../be/task-ui-spec";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";

/**
 * The body that a text-only surface posts (Linear, Jira, the legacy Slack
 * card, the Slack Work Object), with the task's card appended as plain text.
 * Returns `body` itself when the flag is off or the task has no stored spec,
 * so the posted text stays byte-identical to the text without this feature.
 * The appended fallback goes through `scrubSecrets`.
 */
export async function withUiSpecFallback(taskId: string, body: string): Promise<string> {
  if (!isEnvFlagEnabled("UI_SPEC_ENABLED", false)) return body;
  const stored = await getTaskUiSpec(taskId);
  if (!stored?.fallbackText) return body;
  // Stored scrubbed; scrubbed again at egress, since these sends post it as is.
  const fallbackText = scrubSecrets(stored.fallbackText);
  return body ? `${body}\n\n${fallbackText}` : fallbackText;
}
