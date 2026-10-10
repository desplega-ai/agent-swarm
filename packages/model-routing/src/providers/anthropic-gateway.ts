import { envValue } from "../env.ts";
import { defineRouteProvider } from "../protocols.ts";
import type { Env, ModelRoute } from "../types.ts";
import { checkAnthropicModels } from "./anthropic-models.ts";
import { secretEnv } from "./secret-env.ts";

/**
 * `ANTHROPIC_CUSTOM_HEADERS` ("Name: value" per line), which Claude Code sends
 * on every request. Read from env, never stored on the route, because gateways
 * put credentials there (Cloudflare `cf-aig-authorization`).
 */
function customHeaders(route: ModelRoute, env: Env): Record<string, string> {
  if (route.source !== "default") return {};
  const raw = envValue(env, "ANTHROPIC_CUSTOM_HEADERS");
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

/**
 * Any Anthropic Messages-compatible endpoint that is not Anthropic: LiteLLM,
 * CLIProxyAPI, OpenRouter's Anthropic endpoint, Vercel AI Gateway, Portkey,
 * Cloudflare AI Gateway.
 */
export const anthropicGatewayProvider = defineRouteProvider({
  id: "anthropic-gateway",
  name: "Anthropic-compatible gateway",
  protocols: ["anthropic-messages"],
  requiredEnv: (route) => secretEnv(route),
  validate: (ctx) =>
    checkAnthropicModels(ctx, {
      extraHeaders: customHeaders(ctx.route, ctx.env),
      notFoundIsConfigured: true,
    }),
});
