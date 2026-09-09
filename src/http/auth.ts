import type { IncomingMessage } from "node:http";
import { findUserById, fingerprintApiKey, resolveUserByToken } from "../be/users";
import type { User } from "../types";
import { verifyPageSession } from "../utils/page-session";
import type { HttpRequestAuth } from "../utils/request-auth-context";

function extractBearer(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function singleHeader(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? null;
}

export async function resolveHttpRequestAuth(
  req: IncomingMessage,
  apiKey: string | undefined,
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
      if (payload.uid) {
        const user = await findUserById(payload.uid);
        if (!isActiveUser(user)) return null;
        return { kind: "user", userId: user.id, user };
      }
    }
    return { kind: "operator", fingerprint: fingerprintApiKey(bearer) };
  }

  if (bearer.startsWith("aswt_")) {
    const user = await resolveUserByToken(bearer);
    if (isActiveUser(user)) {
      return { kind: "user", userId: user.id, user };
    }
  }

  return null;
}

function isActiveUser(user: User | null): user is User {
  return !!user && user.status === "active";
}
