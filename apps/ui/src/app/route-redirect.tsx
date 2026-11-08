import { type Location, Navigate, useLocation, useParams } from "react-router-dom";

type Params = Record<string, string | undefined>;

interface RouteRedirectProps {
  /**
   * The redirect target: a fixed path, or a builder that reads the matched
   * route params and the current location. The target may carry its own
   * `?query` and `#hash`.
   */
  to: string | ((params: Params, location: Location) => string);
  /** Incoming query params to leave behind (an old `?tab=` that the target replaces). */
  drop?: readonly string[];
}

/**
 * Builds the final redirect URL: the target, plus every incoming query param
 * the target does not set itself (and that is not in `drop`), plus the
 * incoming hash when the target has none. Pure, so tests cover it directly.
 */
export function redirectTarget(
  target: string,
  incoming: { search: string; hash: string },
  drop: readonly string[] = [],
): string {
  const url = new URL(target, "http://redirect.invalid");
  const params = url.searchParams;
  for (const [key, value] of new URLSearchParams(incoming.search)) {
    if (drop.includes(key) || params.has(key)) continue;
    params.append(key, value);
  }
  const query = params.toString();
  const hash = url.hash || incoming.hash;
  return `${url.pathname}${query ? `?${query}` : ""}${hash}`;
}

/**
 * Backward-compat redirect for a moved route. It keeps the deep-link params,
 * the query (`?tab=`, `?oauth=`, `?new=1&name=...`) and the hash, and it
 * replaces the history entry.
 */
export function RouteRedirect({ to, drop }: RouteRedirectProps) {
  const params = useParams();
  const location = useLocation();
  const target = typeof to === "string" ? to : to(params, location);
  return <Navigate replace to={redirectTarget(target, location, drop)} />;
}
