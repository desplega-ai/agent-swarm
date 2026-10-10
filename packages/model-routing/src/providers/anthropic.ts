import { defineRouteProvider } from "../protocols.ts";
import { checkAnthropicModels } from "./anthropic-models.ts";
import { secretEnv } from "./secret-env.ts";

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/** Anthropic's first-party API with an `ANTHROPIC_API_KEY`. */
export const anthropicProvider = defineRouteProvider({
  id: "anthropic",
  name: "Anthropic API",
  protocols: ["anthropic-messages"],
  defaultBaseUrl: ANTHROPIC_API_BASE_URL,
  requiredEnv: (route) => secretEnv(route),
  validate: (ctx) => checkAnthropicModels(ctx),
});
