import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../../be/audit-user";
import { ensureHttpPermission } from "../config";

/**
 * Query for `GET /api/trackers/{linear,jira}/authorize`. `format=json` returns
 * the consent URL instead of a 302, so a browser client can send its bearer
 * on a `fetch` and then navigate to the provider itself.
 */
export const TrackerAuthorizeQuerySchema = z.object({
  redirect: z.string().optional(),
  format: z.enum(["redirect", "json"]).optional(),
});

export const TrackerAuthorizeUrlSchema = z.object({ authorizeUrl: z.string() });

/**
 * Starting a tracker OAuth flow lands the provider's tokens on the swarm-wide
 * `default` authorization, so it takes the same permission as the generic
 * `POST /api/oauth-apps/{id}/authorize-url` route. Writes a 403 and returns
 * null on denial; otherwise returns the initiating user (null for the operator
 * key or an agent) to record on the pending row.
 */
export async function ensureTrackerAuthorizeAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  providerName: string,
): Promise<{ userId: string | null } | null> {
  const header = req.headers["x-agent-id"];
  const agentId = Array.isArray(header) ? header[0] : header;
  const allowed = await ensureHttpPermission(
    req,
    res,
    "oauth-authorization.manage",
    `Only the lead can start the ${providerName} OAuth flow.`,
    agentId,
  );
  if (!allowed) return null;
  return { userId: await resolveHttpAuditUserId(req, agentId) };
}
