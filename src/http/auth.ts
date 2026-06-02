import type { IncomingMessage } from "node:http";
import { fingerprintApiKey, resolveUserByToken } from "../be/users";
import type { User } from "../types";
import type { HttpRequestAuth } from "../utils/request-auth-context";

function extractBearer(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export function resolveHttpRequestAuth(
  req: IncomingMessage,
  apiKey: string | undefined,
): HttpRequestAuth | null {
  const bearer = extractBearer(req);
  if (!bearer) return null;

  if (apiKey && bearer === apiKey) {
    return { kind: "operator", fingerprint: fingerprintApiKey(bearer) };
  }

  if (bearer.startsWith("aswt_")) {
    const user = resolveUserByToken(bearer);
    if (isActiveUser(user)) {
      return { kind: "user", userId: user.id, user };
    }
  }

  return null;
}

function isActiveUser(user: User | null): user is User {
  return !!user && user.status === "active";
}
