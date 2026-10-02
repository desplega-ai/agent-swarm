import { envValue } from "./env.ts";
import { isRoutableHarness } from "./protocols.ts";
import { getRouteProvider } from "./providers/index.ts";
import { createScopedFetch, ScopedFetchError } from "./scoped-fetch.ts";
import type { Env, ModelRoute, RouteCredentialStatus, RouteValidation } from "./types.ts";

const VALIDATE_TIMEOUT_MS = 5_000;

function describeRoute(route: ModelRoute, providerName: string): string {
  return route.baseUrl ? `${providerName} at ${route.baseUrl}` : providerName;
}

/** Presence gate: every env key the route's provider requires is set. */
export function routeCredentialStatus(route: ModelRoute, env: Env): RouteCredentialStatus {
  const provider = getRouteProvider(route.provider);
  if (!provider) {
    return { ready: false, missing: [], hint: `Unknown route provider "${route.provider}".` };
  }
  const missing = provider.requiredEnv(route).filter((key) => !envValue(env, key));
  const where = describeRoute(route, provider.name);
  return missing.length === 0
    ? { ready: true, missing: [], hint: `Routing through ${where}.` }
    : { ready: false, missing, hint: `${where} needs ${missing.join(", ")}.` };
}

/** Error message when `harness` may not use `route`, else null. */
export function assertRouteHarness(route: ModelRoute, harness: string): string | null {
  const provider = getRouteProvider(route.provider);
  if (!provider) return `Unknown route provider "${route.provider}".`;
  if (!isRoutableHarness(harness)) return `Harness "${harness}" cannot use a model route.`;
  if (provider.harnesses && !provider.harnesses.includes(harness)) {
    return `${provider.name} routes are only available to the ${provider.harnesses.join(", ")} harness.`;
  }
  return null;
}

/**
 * Presence gate, then the provider's free `validate`. Network goes only to the
 * route's own origin (`createScopedFetch`). No `validate` → `configured`.
 */
export async function validateRoute(
  route: ModelRoute,
  env: Env,
  opts: { timeoutMs?: number } = {},
): Promise<RouteValidation> {
  const provider = getRouteProvider(route.provider);
  const status = routeCredentialStatus(route, env);
  if (!provider || !status.ready) {
    return { status: "failed", reason: status.hint, missing: status.missing };
  }
  if (!provider.validate) {
    return {
      status: "configured",
      reason: `${provider.name} has no free credential check; the first task proves the route.`,
    };
  }
  const baseUrl = route.baseUrl ?? provider.defaultBaseUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? VALIDATE_TIMEOUT_MS);
  try {
    const scopedFetch = baseUrl
      ? createScopedFetch(baseUrl)
      : () => Promise.reject(new ScopedFetchError(`Route "${route.name}" has no base URL.`));
    return await provider.validate({ route, env, fetch: scopedFetch, signal: controller.signal });
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
