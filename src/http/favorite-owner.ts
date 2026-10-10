import type { IncomingMessage } from "node:http";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { findUserById } from "../be/users";
import { getRequestAuth } from "../utils/request-auth-context";

export type FavoriteOwner = {
  scope: string;
  userId: string | null;
  actorId: string;
};

/**
 * Header the dashboard sends with the identity picked in its user picker.
 * The dashboard authenticates with the shared operator key, so without it
 * every person using the dashboard would share one favorite set.
 */
export const DASHBOARD_USER_HEADER = "x-swarm-user-id";

function dashboardUserIdHeader(req: IncomingMessage): string | null {
  const raw = req.headers[DASHBOARD_USER_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value : null;
}

/**
 * Resolve the authenticated principal that owns favorite state.
 *
 * The hosted dashboard authenticates with the deployment's operator key,
 * agents authenticate with that same key plus `X-Agent-ID`, and end-user REST
 * clients authenticate with user-bound `aswt_` tokens. Agent traffic must be
 * resolved through its owned task before the transport-level operator auth is
 * allowed to select the dashboard's shared scope.
 *
 * An operator-key dashboard request names its picked user in
 * `X-Swarm-User-Id`; an active user there owns the favorites. The operator key
 * is fully trusted, so the header needs no further proof. A user token or a
 * page session never honors the header. `dashboardUser: false` keeps the
 * shared operator scope for callers whose stored state predates the header.
 */
export async function resolveHttpFavoriteOwner(
  req: IncomingMessage,
  callerAgentId: string | undefined,
  opts: { dashboardUser?: boolean } = {},
): Promise<FavoriteOwner | null> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "user") {
    return { scope: `user:${auth.userId}`, userId: auth.userId, actorId: auth.userId };
  }
  if (auth?.kind === "operator" && !callerAgentId) {
    const pickedUserId =
      opts.dashboardUser === false || auth.page ? null : dashboardUserIdHeader(req);
    if (pickedUserId) {
      const user = await findUserById(pickedUserId);
      if (user?.status === "active") {
        return { scope: `user:${user.id}`, userId: user.id, actorId: user.id };
      }
    }
    return {
      // A deployment has one configured operator key. Keep its dashboard
      // favorites stable across key rotation; the fingerprint remains the
      // audit actor, not the storage scope. Tabs with no picked identity
      // land here.
      scope: "operator",
      userId: null,
      actorId: auth.fingerprint,
    };
  }

  const userId = await resolveHttpAuditUserId(req, callerAgentId);
  return userId ? { scope: `user:${userId}`, userId, actorId: userId } : null;
}
