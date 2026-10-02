import type { ModelRoute } from "../types.ts";

/** The env key holding the route's secret, when its auth has one. */
export function secretEnv(route: ModelRoute): string[] {
  const { auth } = route;
  return "secretKey" in auth ? [auth.secretKey] : [];
}
