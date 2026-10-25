import { envValue, isEnvTruthy } from "./env.ts";
import { ANTHROPIC_API_BASE_URL } from "./providers/anthropic.ts";
import { foundryBaseUrl } from "./providers/foundry.ts";
import { OPENAI_API_BASE_URL } from "./providers/openai-gateway.ts";
import type { Env, ModelRoute, RoutableHarness, RouteAuth } from "./types.ts";

/** True when `url` points at Anthropic's own API, so it is not a gateway. */
export function isFirstPartyAnthropicUrl(url: string): boolean {
  try {
    return new URL(url).origin === ANTHROPIC_API_BASE_URL;
  } catch {
    return false;
  }
}

/** True when `url` points at OpenAI's own API, so it is not a gateway. */
export function isFirstPartyOpenAiUrl(url: string): boolean {
  try {
    return new URL(url).origin === OPENAI_API_BASE_URL;
  } catch {
    return false;
  }
}

/**
 * Codex gateway env. Swarm-owned names, because Codex has none: 0.164 ignores
 * `OPENAI_BASE_URL` and reads no key from env for its built-in provider, so a
 * gateway needs a generated `[model_providers.*]` block. Not `OPENAI_API_KEY`,
 * which embeddings send to api.openai.com.
 */
export const CODEX_GATEWAY_BASE_URL = "CODEX_GATEWAY_BASE_URL";
export const CODEX_GATEWAY_API_KEY = "CODEX_GATEWAY_API_KEY";

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
    // With no gateway key this still names the gateway, so the gate reports
    // the gateway's missing key. Never a subscription route, even when
    // CLAUDE_CODE_OAUTH_TOKEN is set: Claude Code would send that token as
    // Bearer to ANTHROPIC_BASE_URL (verified on 2.1.286), and Anthropic's
    // terms do not allow routing Pro/Max credentials through a third party.
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
 * A gateway base URL that is not api.openai.com yields a gateway route. With no
 * gateway key the route still names the gateway, so the gate reports the
 * missing key instead of falling back to the OAuth pool.
 */
function deriveCodexDefaultRoute(env: Env): ModelRoute | null {
  const baseUrl = envValue(env, CODEX_GATEWAY_BASE_URL);
  if (!baseUrl || isFirstPartyOpenAiUrl(baseUrl)) return null;
  return defaultRoute("codex", {
    provider: "openai-gateway",
    protocol: "openai-responses",
    baseUrl,
    auth: { kind: "bearer", secretKey: CODEX_GATEWAY_API_KEY },
  });
}

/**
 * The route a harness uses when no stored route is assigned, derived from env
 * exactly as the harness CLI reads it. Claude precedence:
 * `CLAUDE_CODE_USE_FOUNDRY` > `CLAUDE_CODE_USE_BEDROCK` > `CLAUDE_CODE_USE_VERTEX`
 * > `ANTHROPIC_BASE_URL` (non-Anthropic) + `ANTHROPIC_AUTH_TOKEN` | `ANTHROPIC_API_KEY`
 * > `CLAUDE_CODE_OAUTH_TOKEN` > `ANTHROPIC_API_KEY`. A non-Anthropic
 * `ANTHROPIC_BASE_URL` always yields a gateway route; without a gateway key
 * that route is not ready, whatever `CLAUDE_CODE_OAUTH_TOKEN` holds.
 * Codex: only the gateway route (`CODEX_GATEWAY_BASE_URL` + `CODEX_GATEWAY_API_KEY`)
 * lives here; null means the OAuth / `OPENAI_API_KEY` / auth.json checks apply.
 *
 * Returns null when no route can be derived, and for harnesses whose default
 * routes have not moved here yet (callers keep their current checks).
 */
export function deriveDefaultRoute(harness: string, env: Env): ModelRoute | null {
  if (harness === "claude") return deriveClaudeDefaultRoute(env);
  if (harness === "codex") return deriveCodexDefaultRoute(env);
  return null;
}

/**
 * Credential env vars the harness must not see on this route. A claude route
 * that is not the subscription drops `CLAUDE_CODE_OAUTH_TOKEN`, so the token
 * never rides along to a gateway or cloud endpoint and claude-bridge (which
 * authenticates from it) stays off. A codex gateway route drops the OAuth blob
 * and `OPENAI_API_KEY` from the Codex CLI env.
 */
export function routeUnsetEnv(harness: string, route: ModelRoute): string[] {
  if (harness === "claude" && route.provider !== "claude-subscription") {
    return ["CLAUDE_CODE_OAUTH_TOKEN"];
  }
  if (harness === "codex" && route.provider === "openai-gateway") {
    return ["CODEX_OAUTH", "OPENAI_API_KEY"];
  }
  return [];
}
