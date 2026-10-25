import { defineRouteProvider } from "../protocols.ts";
import type { RouteContext, RouteValidation } from "../types.ts";
import { modelIds, readBody, routeAuthHeaders } from "./anthropic-models.ts";
import { secretEnv } from "./secret-env.ts";

export const OPENAI_API_BASE_URL = "https://api.openai.com";

/**
 * `GET {baseUrl}/models` with the gateway key, the free OpenAI-compatible
 * credential check. The base URL carries the version prefix the way Codex's
 * `base_url` does (`https://gw.example.com/v1` → `/v1/models`). A gateway that
 * does not list models (404/405) proves nothing about the key: `configured`.
 */
async function checkOpenAiModels(ctx: RouteContext): Promise<RouteValidation> {
  const res = await ctx.fetch("/models", {
    method: "GET",
    headers: routeAuthHeaders(ctx),
    signal: ctx.signal,
  });
  const body = await readBody(res);
  if (res.ok) return { status: "verified", models: modelIds(body) };
  if (res.status === 404 || res.status === 405) {
    return {
      status: "configured",
      reason: `HTTP ${res.status}: the endpoint does not list models, so the key was not checked`,
    };
  }
  return {
    status: "failed",
    reason: `HTTP ${res.status}: ${body.slice(0, 200)}`,
    httpStatus: res.status,
  };
}

/**
 * Any OpenAI Responses-compatible endpoint that is not OpenAI (Sub2API,
 * LiteLLM, CLIProxyAPI). Codex only speaks the Responses API.
 */
export const openAiGatewayProvider = defineRouteProvider({
  id: "openai-gateway",
  name: "OpenAI-compatible gateway",
  protocols: ["openai-responses"],
  harnesses: ["codex"],
  requiredEnv: (route) => secretEnv(route),
  validate: checkOpenAiModels,
});
