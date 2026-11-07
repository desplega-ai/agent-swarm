/**
 * Model routing for the `fx` harness. Pure, so the API server can validate a
 * model and the worker can route it without importing the adapter.
 *
 * | Swarm model string           | fx provider (`FX_PROVIDER`)       | `fx acp --model` | Key                  |
 * |------------------------------|-----------------------------------|------------------|----------------------|
 * | `openrouter/<vendor>/<id>`   | `openrouter` (custom connection)  | `<vendor>/<id>`  | `OPENROUTER_API_KEY` |
 * | `vercel/<vendor>/<id>`       | `gateway` (built in)              | `<vendor>/<id>`  | `AI_GATEWAY_API_KEY` |
 * | bare `<id>` (no slash)       | `openai` (custom connection)      | `<id>`           | `OPENAI_API_KEY`     |
 *
 * Anything else (`nan/…`, `helmcode/…`, `anthropic/…`) is rejected with a reason.
 */
import { type FxRoute, fxModelRoute } from "@desplega/model-catalog";
import { DEFAULT_MODEL_TIER_MAP } from "../types";

export type { FxRoute };

/** An fx route plus the swarm model string it came from. */
export type ResolvedFxRoute = FxRoute & { model: string };

/** Every key an fx route can read, in route-table order. */
export const FX_ROUTE_KEY_VARS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
] as const;

/**
 * The fx route for a swarm model string, or the reason it has none. An empty
 * model means the regular tier default.
 */
export function resolveFxRoute(model: string | undefined): ResolvedFxRoute | { error: string } {
  const value = model?.trim() || DEFAULT_MODEL_TIER_MAP.fx.regular;
  const route = fxModelRoute(value);
  return "error" in route ? route : { ...route, model: value };
}

/** {@link resolveFxRoute}, throwing the rejection reason. */
export function requireFxRoute(model: string | undefined): ResolvedFxRoute {
  const route = resolveFxRoute(model);
  if ("error" in route) throw new Error(route.error);
  return route;
}
