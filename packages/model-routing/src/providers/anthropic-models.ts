import { envValue } from "../env.ts";
import type { Env, RouteContext, RouteValidation } from "../types.ts";

const ANTHROPIC_VERSION = "2023-06-01";

/** Request headers that carry the route's credential. Empty when the route has no header secret. */
export function routeAuthHeaders(ctx: {
  route: RouteContext["route"];
  env: Env;
}): Record<string, string> {
  const { auth } = ctx.route;
  if (auth.kind !== "bearer" && auth.kind !== "x-api-key" && auth.kind !== "header") return {};
  const secret = envValue(ctx.env, auth.secretKey);
  if (!secret) return {};
  if (auth.kind === "bearer") return { Authorization: `Bearer ${secret}` };
  if (auth.kind === "x-api-key") return { "x-api-key": secret };
  return { [auth.header]: secret };
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function modelIds(body: string): string[] | undefined {
  try {
    const parsed = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(parsed.data)) return undefined;
    return parsed.data.flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
  } catch {
    return undefined;
  }
}

/**
 * `GET {baseUrl}/v1/models`, the free Anthropic Messages credential check.
 * `notFoundIsConfigured`: gateways may not expose the list (404/405), which
 * proves nothing about the key, so it maps to `configured` instead of `failed`.
 */
export async function checkAnthropicModels(
  ctx: RouteContext,
  opts: { extraHeaders?: Record<string, string>; notFoundIsConfigured?: boolean } = {},
): Promise<RouteValidation> {
  const res = await ctx.fetch("/v1/models", {
    method: "GET",
    headers: {
      "anthropic-version": ANTHROPIC_VERSION,
      ...opts.extraHeaders,
      ...routeAuthHeaders(ctx),
    },
    signal: ctx.signal,
  });
  const body = await readBody(res);
  if (res.ok) return { status: "verified", models: modelIds(body) };
  if (opts.notFoundIsConfigured && (res.status === 404 || res.status === 405)) {
    return {
      status: "configured",
      reason: `HTTP ${res.status}: the endpoint does not list models, so the key was not checked`,
    };
  }
  return { status: "failed", reason: `HTTP ${res.status}: ${body.slice(0, 200)}` };
}
