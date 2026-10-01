import { defineRouteProvider } from "../protocols.ts";
import { ANTHROPIC_API_BASE_URL } from "./anthropic.ts";

/**
 * Claude Pro/Max OAuth (`CLAUDE_CODE_OAUTH_TOKEN`). Only the claude harness may
 * use the Claude subscription, so this provider declares `harnesses: ["claude"]`.
 */
export const claudeSubscriptionProvider = defineRouteProvider({
  id: "claude-subscription",
  name: "Claude subscription",
  protocols: ["anthropic-messages"],
  harnesses: ["claude"],
  defaultBaseUrl: ANTHROPIC_API_BASE_URL,
  requiredEnv: () => ["CLAUDE_CODE_OAUTH_TOKEN"],
  // Presence only, as before #1800: Claude Code refreshes the OAuth token
  // itself, and a stale-but-refreshable token must not read as broken.
  validate: async () => ({ status: "verified" }),
});
