// Worker-side hooks do not load base-prompt, which normally registers these
// code-default templates.
import "./session-templates.ts";
import { resolveTemplateAsync, resolveTemplateFromCode } from "./resolver.ts";

const CONTEXT_BOUND_NOTE_TEMPLATE = "system.agent.context.bound_note";

/**
 * Render the one-time context-bound note. Returns "" when an operator disabled
 * the template; falls back to the code default if resolution fails.
 */
export async function renderContextBoundNote(contextTokens: number): Promise<string> {
  const variables = { contextTokens: Math.round(contextTokens).toLocaleString("en-US") };
  try {
    const result = await resolveTemplateAsync(CONTEXT_BOUND_NOTE_TEMPLATE, variables);
    return result.skipped ? "" : result.text;
  } catch {
    return resolveTemplateFromCode(CONTEXT_BOUND_NOTE_TEMPLATE, variables).text;
  }
}
