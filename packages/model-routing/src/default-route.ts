import { envValue, isEnvTruthy } from "./env.ts";
import { ANTHROPIC_API_BASE_URL } from "./providers/anthropic.ts";
import { foundryBaseUrl } from "./providers/foundry.ts";
import type { Env, ModelRoute, RoutableHarness, RouteAuth } from "./types.ts";

/** True when `url` points at Anthropic's own API, so it is not a gateway. */
export function isFirstPartyAnthropicUrl(url: string): boolean {
  try {
    return new URL(url).origin === ANTHROPIC_API_BASE_URL;
  } catch {
    return false;
  }
}

function defaultRoute(
  harness: RoutableHarness,
  route: Omit<ModelRoute, "id" | "name" | "source">,
): ModelRoute {
  return { id: `default:${harness}`, name: `default:${harness}`, source: "default", ...route };
}

function deriveClaudeDefaultRoute(env: Env): ModelRoute | null {
  if (isEnvTruthy(env, "CLAUDE_CODE_USE_FOUNDRY")) {
    const resource = envValue(env, "ANTHROPIC_FOUNDRY_RESOURCE");
    const auth: RouteAuth = envValue(env, "ANTHROPIC_FOUNDRY_AUTH_TOKEN")
      ? { kind: "bearer", secretKey: "ANTHROPIC_FOUNDRY_AUTH_TOKEN" }
      : envValue(env, "ANTHROPIC_FOUNDRY_API_KEY")
        ? { kind: "x-api-key", secretKey: "ANTHROPIC_FOUNDRY_API_KEY" }
        : { kind: "cloud-chain" };
    return defaultRoute("claude", {
      provider: "foundry",
      protocol: "foundry",
      baseUrl:
        envValue(env, "ANTHROPIC_FOUNDRY_BASE_URL") ??
        (resource ? foundryBaseUrl(resource) : undefined),
      auth,
      cloud: { resource },
    });
  }

  if (isEnvTruthy(env, "CLAUDE_CODE_USE_BEDROCK")) {
    const region = envValue(env, "AWS_REGION");
    return defaultRoute("claude", {
      provider: "bedrock",
      protocol: "bedrock",
      baseUrl:
        envValue(env, "ANTHROPIC_BEDROCK_BASE_URL") ??
        (region ? `https://bedrock-runtime.${region}.amazonaws.com` : undefined),
      auth: envValue(env, "AWS_BEARER_TOKEN_BEDROCK")
        ? { kind: "bearer", secretKey: "AWS_BEARER_TOKEN_BEDROCK" }
        : { kind: "cloud-chain" },
      cloud: { region },
    });
  }

  if (isEnvTruthy(env, "CLAUDE_CODE_USE_VERTEX")) {
    const region = envValue(env, "CLOUD_ML_REGION");
    const vertexHost =
      region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
    return defaultRoute("claude", {
      provider: "vertex",
      protocol: "vertex",
      baseUrl:
        envValue(env, "ANTHROPIC_VERTEX_BASE_URL") ??
        (region ? `https://${vertexHost}` : undefined),
      auth: { kind: "cloud-chain" },
      cloud: { region, project: envValue(env, "ANTHROPIC_VERTEX_PROJECT_ID") },
    });
  }

  const oauthToken = envValue(env, "CLAUDE_CODE_OAUTH_TOKEN");
  const baseUrl = envValue(env, "ANTHROPIC_BASE_URL");
  if (baseUrl && !isFirstPartyAnthropicUrl(baseUrl)) {
    const authToken = envValue(env, "ANTHROPIC_AUTH_TOKEN");
    const apiKey = envValue(env, "ANTHROPIC_API_KEY");
    if (!authToken && !apiKey && oauthToken) {
      // Gateway URL + subscription token only: Claude Code sends the OAuth
      // token to ANTHROPIC_BASE_URL (verified on 2.1.286). Kept working for
      // pass-through proxies; the route records where the token goes.
      return defaultRoute("claude", {
        provider: "claude-subscription",
        protocol: "anthropic-messages",
        baseUrl,
        auth: { kind: "subscription", plan: "claude" },
      });
    }
    // With no key at all this still names the gateway, so the gate reports
    // the gateway's missing key instead of a first-party one.
    return defaultRoute("claude", {
      provider: "anthropic-gateway",
      protocol: "anthropic-messages",
      baseUrl,
      auth:
        authToken || !apiKey
          ? { kind: "bearer", secretKey: "ANTHROPIC_AUTH_TOKEN" }
          : { kind: "x-api-key", secretKey: "ANTHROPIC_API_KEY" },
    });
  }

  if (oauthToken) {
    return defaultRoute("claude", {
      provider: "claude-subscription",
      protocol: "anthropic-messages",
      baseUrl: baseUrl ?? ANTHROPIC_API_BASE_URL,
      auth: { kind: "subscription", plan: "claude" },
    });
  }

  if (envValue(env, "ANTHROPIC_API_KEY")) {
    return defaultRoute("claude", {
      provider: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: baseUrl ?? ANTHROPIC_API_BASE_URL,
      auth: { kind: "x-api-key", secretKey: "ANTHROPIC_API_KEY" },
    });
  }

  return null;
}

/**
 * The route a harness uses when no stored route is assigned, derived from env
 * exactly as the harness CLI reads it. Claude precedence:
 * `CLAUDE_CODE_USE_FOUNDRY` > `CLAUDE_CODE_USE_BEDROCK` > `CLAUDE_CODE_USE_VERTEX`
 * > `ANTHROPIC_BASE_URL` (non-Anthropic) + `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_API_KEY`
 * > `CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_API_KEY`.
 *
 * Returns null when no route can be derived, and for harnesses whose default
 * routes have not moved here yet (callers keep their current checks).
 */
export function deriveDefaultRoute(harness: string, env: Env): ModelRoute | null {
  if (harness === "claude") return deriveClaudeDefaultRoute(env);
  return null;
}

/**
 * Credential env vars the harness must not see on this route. A claude route
 * that is not the subscription drops `CLAUDE_CODE_OAUTH_TOKEN`, so the token
 * never rides along to a gateway or cloud endpoint and claude-bridge (which
 * authenticates from it) stays off.
 */
export function routeUnsetEnv(harness: string, route: ModelRoute): string[] {
  if (harness === "claude" && route.provider !== "claude-subscription") {
    return ["CLAUDE_CODE_OAUTH_TOKEN"];
  }
  return [];
}
