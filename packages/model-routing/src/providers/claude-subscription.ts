import { envValue } from "../env.ts";
import { defineRouteProvider } from "../protocols.ts";
import { ANTHROPIC_API_BASE_URL } from "./anthropic.ts";

function errorType(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown } };
    return typeof parsed.error?.type === "string" ? parsed.error.type : undefined;
  } catch {
    return undefined;
  }
}

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
  // `GET /api/oauth/profile` runs no inference. It is an undocumented account
  // endpoint, so workers call it once per token value (boot or change), never
  // in the 10 min recheck (see `recheckableFailures`). A `claude setup-token` token
  // has only the `user:inference` scope, so it gets 403 `permission_error`:
  // the token authenticated but cannot read the profile. A rejected or expired
  // token gets 401. Claude Code cannot refresh a token that comes from the
  // env (there is no refresh token), so a 401 is a real failure.
  validate: async (ctx) => {
    const token = envValue(ctx.env, "CLAUDE_CODE_OAUTH_TOKEN");
    const res = await ctx.fetch("/api/oauth/profile", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ctx.signal,
    });
    if (res.ok) return { status: "verified" };
    const body = await res.text().catch(() => "");
    if (res.status === 403 && errorType(body) === "permission_error") {
      return { status: "verified" };
    }
    // Anthropic throttles its account endpoints (429). A throttle or an
    // outage says nothing about the token: report it as not tested.
    if (res.status === 429 || res.status >= 500) {
      return {
        status: "configured",
        reason: `Anthropic did not answer the token check (HTTP ${res.status}), so it was not tested.`,
      };
    }
    if (res.status === 401) {
      return {
        status: "failed",
        reason:
          "Anthropic rejected the Claude subscription token (HTTP 401). Make a new one with the claude setup-token command.",
        httpStatus: 401,
      };
    }
    return {
      status: "failed",
      reason: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      httpStatus: res.status,
    };
  },
});
