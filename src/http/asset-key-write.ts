import type { IncomingMessage } from "node:http";
import { authorizeAssetKeyWrite } from "../be/asset-key-auth";
import { resolveHttpRequesterUserId } from "../be/audit-user";
import { findUserById } from "../be/users";
import type { User } from "../types";
import { getRequestAuth, isOperatorAuth } from "../utils/request-auth-context";
import { dashboardUserIdHeader } from "./favorite-owner";

/**
 * The active user an operator-key dashboard request names in `X-Swarm-User-Id`.
 * The operator key is fully trusted, so the header needs no further proof (same
 * rule as favorites and session access). Agents, page sessions, user tokens and
 * unauthenticated callers never pick a user. A merged-away user is refused, as
 * every credential that names one is.
 */
export async function resolveDashboardUser(
  req: IncomingMessage,
  callerAgentId: string | undefined,
): Promise<User | null> {
  const auth = getRequestAuth(req);
  if (!isOperatorAuth(auth) || auth.page || callerAgentId || req.headers["x-agent-id"]) return null;
  const picked = dashboardUserIdHeader(req);
  const user = picked ? await findUserById(picked) : null;
  return user?.status === "active" && !user.mergedIntoUserId ? user : null;
}

/**
 * {@link authorizeAssetKeyWrite} for an HTTP request. The trusted user is the
 * request's requester (pass `trustedUserId` when already resolved), else the
 * dashboard's picked user, so an operator-key dashboard can write to its own
 * user's `personal/<user>/` keys and no one else's.
 */
export async function authorizeHttpAssetKeyWrite(
  req: IncomingMessage,
  callerAgentId: string | undefined,
  key: string,
  trustedUserId?: string | null,
): Promise<string> {
  const requester =
    trustedUserId === undefined
      ? await resolveHttpRequesterUserId(req, callerAgentId)
      : trustedUserId;
  return authorizeAssetKeyWrite(
    key,
    requester ?? (await resolveDashboardUser(req, callerAgentId))?.id ?? null,
  );
}
