/**
 * Provider-agnostic credential check dispatcher.
 *
 * Used by:
 * - The worker boot loop (`src/commands/credential-wait.ts`) to decide
 *   whether the worker can claim tasks yet.
 * - The dashboard credential-status endpoint, which surfaces the per-provider
 *   `missing[]` list as a "blocked on …" hint.
 *
 * The predicate functions live alongside their adapters so they evolve
 * together; this module is a thin switch with documentation/UI hints
 * exported as a static map for the credential-status API.
 */

import { checkClaudeCredentials } from "./claude-adapter";
import { checkClaudeManagedCredentials } from "./claude-managed-adapter";
import { checkCodexCredentials } from "./codex-adapter";
import { checkDevinCredentials } from "./devin-adapter";
import { checkOpencodeCredentials } from "./opencode-adapter";
import { checkPiMonoCredentials } from "./pi-mono-adapter";
import type { CredCheckOptions, CredStatus } from "./types";

export type SupportedProvider = "claude" | "claude-managed" | "codex" | "devin" | "opencode" | "pi";

/**
 * Static documentation of which env vars each provider considers when running
 * `checkCredentials`. Used by the dashboard to render hints before any worker
 * has reported its dynamic state. The arrays are illustrative — the real
 * authoritative answer always comes from the predicate function (which may
 * fold in `MODEL_OVERRIDE`-conditional logic for pi/opencode and file-based
 * fallbacks for codex/pi/opencode).
 */
export const REQUIRED_CRED_VARS_BY_PROVIDER: Record<SupportedProvider, readonly string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "claude-managed": [
    "ANTHROPIC_API_KEY",
    "MANAGED_AGENT_ID",
    "MANAGED_ENVIRONMENT_ID",
    "MCP_BASE_URL",
  ],
  codex: ["OPENAI_API_KEY", "CODEX_OAUTH"],
  devin: ["DEVIN_API_KEY", "DEVIN_ORG_ID"],
  opencode: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  pi: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"],
};

/**
 * Run the predicate for `provider`. Unknown providers throw — call sites
 * should treat that as a configuration bug, not a user-correctable state.
 */
export function checkProviderCredentials(
  provider: string,
  env: Record<string, string | undefined>,
  opts?: CredCheckOptions,
): CredStatus {
  switch (provider) {
    case "claude":
      return checkClaudeCredentials(env);
    case "claude-managed":
      return checkClaudeManagedCredentials(env);
    case "codex":
      return checkCodexCredentials(env, opts);
    case "devin":
      return checkDevinCredentials(env);
    case "opencode":
      return checkOpencodeCredentials(env, opts);
    case "pi":
      return checkPiMonoCredentials(env, opts);
    default:
      throw new Error(
        `checkProviderCredentials: unknown provider "${provider}". Supported: claude, claude-managed, codex, devin, opencode, pi.`,
      );
  }
}
