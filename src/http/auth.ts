import type { IncomingMessage } from "node:http";
import { getPage } from "../be/db";
import {
  findUserById,
  fingerprintApiKey,
  resolveSessionToken,
  resolveUserToken,
} from "../be/users";
import type { User } from "../types";
import { verifyPageSession } from "../utils/page-session";
import type { HttpRequestAuth } from "../utils/request-auth-context";

function extractBearer(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

function singleHeader(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? null;
}

export async function resolveHttpRequestAuth(
  req: IncomingMessage,
  apiKey: string | undefined,
  options: { touchSessionToken?: boolean } = {},
): Promise<HttpRequestAuth | null> {
  const bearer = extractBearer(req);
  if (!bearer) return null;

  if (apiKey && bearer === apiKey) {
    const pageSession = singleHeader(req, "x-page-session");
    if (pageSession !== null) {
      const pageId = singleHeader(req, "x-page-id");
      if (!pageId) return null;
      const payload = await verifyPageSession(pageSession);
      if (!payload || payload.pageId !== pageId) return null;
      const storedPage = await getPage(payload.pageId);
      if (!storedPage) return null;
      const page = { id: storedPage.id, executionAgentId: storedPage.agentId };
      if (payload.uid) {
        const user = await findUserById(payload.uid);
        if (!isActiveUser(user)) return null;
        return { kind: "user", userId: user.id, user, page };
      }
      if (payload.op) {
        return { kind: "operator", fingerprint: fingerprintApiKey(bearer), page };
      }
      return { kind: "guest", page };
    }
    return { kind: "operator", fingerprint: fingerprintApiKey(bearer) };
  }

  if (bearer.startsWith("aswt_")) {
    const resolved = await resolveUserToken(bearer);
    const user = resolved?.user ?? null;
    if (resolved && isActiveUser(user)) {
      return { kind: "user", userId: user.id, user, tokenId: resolved.tokenId };
    }
  }

  if (bearer.startsWith("aseph_")) {
    return await resolveSessionToken(bearer, { touch: options.touchSessionToken });
  }

  return null;
}

function isActiveUser(user: User | null): user is User {
  // A merge source (mergedIntoUserId set) is on its way out: the merge route
  // revoked its tokens, and any credential that still names it is refused.
  return !!user && user.status === "active" && !user.mergedIntoUserId;
}
