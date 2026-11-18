// Worker-side callers do not load base-prompt, which normally registers these
// code-default templates.
import "./session-templates.ts";
import { resolveTemplateAsync, resolveTemplateFromCode } from "./resolver.ts";

const SESSION_TURNS_TEMPLATE = "task.followup.session_turns";

export interface SessionTurnsVariables {
  turn_count: number;
  turns: string;
  reply_target: string;
  omitted_note: string;
}

/**
 * Render the Sessions follow-up preamble. Returns "" when an operator
 * disabled the template; falls back to the code default if resolution fails,
 * because a follow-up without its conversation is the failure this prevents.
 */
export async function renderSessionTurnsPreamble(
  variables: SessionTurnsVariables,
): Promise<string> {
  try {
    const result = await resolveTemplateAsync(SESSION_TURNS_TEMPLATE, { ...variables });
    return result.skipped ? "" : result.text;
  } catch {
    return resolveTemplateFromCode(SESSION_TURNS_TEMPLATE, { ...variables }).text;
  }
}
