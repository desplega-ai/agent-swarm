/**
 * Shared context-mode plugin env config for harness subprocesses.
 *
 * The `context-mode` MCP plugin reads `CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY`
 * to decide how often to surface its external-MCP guidance nudge (default 10).
 * We lower it to 3 to increase adoption. All three adapters (claude, codex,
 * opencode) inject this into the subprocess env.
 */

export const CTX_MODE_NUDGE_EVERY = process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY ?? "3";
