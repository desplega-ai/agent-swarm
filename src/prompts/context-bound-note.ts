// Worker-side hooks do not load base-prompt, which normally registers these
// code-default templates.
import "./session-templates.ts";
import { resolveTemplateAsync, resolveTemplateFromCode } from "./resolver.ts";

const CONTEXT_BOUND_NOTE_TEMPLATE = "system.agent.context.bound_note";

/**
 * `contextShare` for the note: " (21% of the 1,000,000-token window)", or ""
 * when the model's window is unknown. Never a percent of the 200k fallback.
 */
function contextShare(contextTokens: number, model: string | undefined): string {
  if (!model) return "";
  try {
    // Lazy and synchronous: the catalog snapshot is large and the Claude hook
    // process loads this module on every tool call, but renders the note at
    // most once. Sync so in-process sessions render no later than before.
    const { clampContextPercent, getKnownContextWindowSize } =
      require("../utils/context-window.ts") as typeof import("../utils/context-window.ts");
    const window = getKnownContextWindowSize(model);
    const percent = clampContextPercent(contextTokens, window);
    if (!window || percent === null) return "";
    return ` (${Math.round(percent)}% of the ${window.toLocaleString("en-US")}-token window)`;
  } catch {
    return "";
  }
}

/**
 * Render the one-time context-bound note. `model` is the session's model, for
 * the window share. Returns "" when an operator disabled the template; falls
 * back to the code default if resolution fails.
 */
export async function renderContextBoundNote(
  contextTokens: number,
  model?: string,
): Promise<string> {
  const variables = {
    contextTokens: Math.round(contextTokens).toLocaleString("en-US"),
    contextShare: contextShare(contextTokens, model),
  };
  try {
    const result = await resolveTemplateAsync(CONTEXT_BOUND_NOTE_TEMPLATE, variables);
    return result.skipped ? "" : result.text;
  } catch {
    return resolveTemplateFromCode(CONTEXT_BOUND_NOTE_TEMPLATE, variables).text;
  }
}
