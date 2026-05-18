/**
 * Operator-auth middleware producing the `op:<sha256(rawKey)[:16]>` fingerprint
 * (Q16) that is embedded as `actor` in `user_identity_events` rows.
 *
 * The bearer-key check already gates every `route({ auth: { apiKey: true } })`
 * route via `src/http/core.ts::handleCore` — so by the time we reach the route
 * handler we know the caller's `Authorization: Bearer <key>` matches the
 * configured swarm key. This helper just re-reads that key, hashes it with
 * `fingerprintApiKey`, and packages it as an `IdentityActor` for the identity
 * mutation helpers in `src/be/users.ts`.
 *
 * MUST read the swarm key via `getApiKey()` from `src/utils/api-key.ts` —
 * direct `process.env.{API_KEY,AGENT_SWARM_API_KEY}` reads are rejected by
 * `scripts/check-api-key-boundary.sh` (CI).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { fingerprintApiKey, type IdentityActor } from "../be/users";
import { getApiKey } from "../utils/api-key";
import { jsonError } from "./utils";

/**
 * Extract the raw bearer key from the request. Returns null if the header is
 * missing or malformed.
 */
function extractBearer(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7);
}

/**
 * Resolve the calling operator's `IdentityActor`. Assumes `handleCore` already
 * 401'd unauthenticated requests; on the off chance the header is missing here
 * (e.g. a route mistakenly opted out of api-key gating), we respond with 401
 * and return null so the caller can short-circuit.
 *
 * Returns null after writing a 401 response. The caller MUST stop processing
 * the request when this returns null.
 */
export function getOperatorActor(req: IncomingMessage, res: ServerResponse): IdentityActor | null {
  const rawKey = extractBearer(req);
  const swarmKey = getApiKey();

  // If no key is configured server-side, the public-route guard already
  // skipped the bearer check. We still need *some* fingerprint for the audit
  // event — fall back to a stable placeholder so callers see consistent shapes.
  if (!swarmKey) {
    return { kind: "operator", id: fingerprintApiKey("") };
  }

  if (!rawKey || rawKey !== swarmKey) {
    jsonError(res, "Unauthorized", 401);
    return null;
  }

  return { kind: "operator", id: fingerprintApiKey(rawKey) };
}
