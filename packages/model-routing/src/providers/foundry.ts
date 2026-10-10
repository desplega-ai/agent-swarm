import { defineRouteProvider } from "../protocols.ts";
import { secretEnv } from "./secret-env.ts";

/** Base URL Claude Code derives from `ANTHROPIC_FOUNDRY_RESOURCE`. */
export function foundryBaseUrl(resource: string): string {
  return `https://${resource}.services.ai.azure.com/anthropic`;
}

/**
 * Microsoft Foundry. Auth is `ANTHROPIC_FOUNDRY_API_KEY` or, without one, the
 * Entra ID credential chain. No free key check exists, so routes report
 * `configured`.
 */
export const foundryProvider = defineRouteProvider({
  id: "foundry",
  name: "Microsoft Foundry",
  protocols: ["foundry"],
  requiredEnv: (route) => [
    ...(route.baseUrl ? [] : ["ANTHROPIC_FOUNDRY_RESOURCE"]),
    ...secretEnv(route),
  ],
});
