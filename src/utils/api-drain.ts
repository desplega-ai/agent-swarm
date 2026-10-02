/**
 * Wire contract for the API drain, shared by the API server and the workers.
 * Keep this file free of DB and server imports: `src/commands/` reads it.
 *
 * While the API is draining (SIGTERM received, still serving) it adds
 * `X-Swarm-Draining: 1` to every response. A worker that sees the header hands
 * off its in-flight tasks and stops taking new ones. An API that never drains
 * never sends the header, so older and newer sides interoperate unchanged.
 */

export const API_DRAINING_HEADER = "X-Swarm-Draining";

/**
 * Upper bound for `API_DRAIN_MAX_MS`. The config validator and the resolver in
 * `src/be/api-drain.ts` both read it, so the config API cannot accept a value
 * the shutdown path would clamp. Keep the API's `stop_grace_period` above the
 * cap plus the time the API needs to close.
 */
export const API_DRAIN_MAX_MS_LIMIT = 120_000;

/** True when an API response carries the drain header. */
export function isApiDrainingResponse(response: { headers: Headers }): boolean {
  return response.headers.get(API_DRAINING_HEADER) === "1";
}
