import { scrubSecrets } from "@/utils/secret-scrubber";
import { assertOAuthEgressUrlSafe } from "./app-validation";

/**
 * Best-effort account identity captured after a successful token exchange.
 * Display-only — never used for authorization decisions.
 */
export interface CapturedIdentity {
  accountEmail: string | null;
  /** JSON string of the raw identity claims we surfaced (email/login/sub). */
  identityJson: string;
}

const IDENTITY_FETCH_TIMEOUT_MS = 5_000;

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Extract the display-relevant identity fields from a claims/userinfo object. */
function extractIdentity(source: Record<string, unknown>): CapturedIdentity | null {
  const email = pickString(source.email);
  const login = pickString(source.login) ?? pickString(source.preferred_username);
  const sub = pickString(source.sub) ?? pickString(source.id);
  if (!email && !login && !sub) return null;
  const claims: Record<string, string> = {};
  if (email) claims.email = email;
  if (login) claims.login = login;
  if (sub) claims.sub = sub;
  return { accountEmail: email, identityJson: JSON.stringify(claims) };
}

/** Decode a JWT id_token payload without signature verification (display-only). */
function decodeIdToken(idToken: string): CapturedIdentity | null {
  const parts = idToken.split(".");
  const payloadSegment = parts[1];
  if (!payloadSegment) return null;
  try {
    const payload = Buffer.from(
      payloadSegment.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return extractIdentity(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Capture the connected account's identity after a token exchange. Prefers a
 * `userinfoUrl` probe (Bearer), falling back to decoding an OIDC `id_token`.
 * All failures are swallowed (scrubbed log) — identity capture must NEVER fail
 * the OAuth callback. Returns null when nothing could be captured.
 */
export async function captureIdentity(input: {
  userinfoUrl?: string | null;
  accessToken: string;
  idToken?: string | null;
}): Promise<CapturedIdentity | null> {
  try {
    if (input.userinfoUrl) {
      // Fail-closed host re-check at egress: we are about to send a live bearer.
      assertOAuthEgressUrlSafe(input.userinfoUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IDENTITY_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(input.userinfoUrl, {
          headers: {
            authorization: `Bearer ${input.accessToken}`,
            accept: "application/json",
          },
          signal: controller.signal,
          // Never follow a redirect: a public userinfoUrl could 302 the bearer
          // toward an internal metadata endpoint. A 3xx is not `.ok`, so it is
          // simply ignored below.
          redirect: "manual",
        });
        if (response.ok) {
          const data = (await response.json()) as unknown;
          if (data && typeof data === "object" && !Array.isArray(data)) {
            const identity = extractIdentity(data as Record<string, unknown>);
            if (identity) return identity;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (input.idToken) {
      return decodeIdToken(input.idToken);
    }
  } catch (err) {
    console.warn(
      scrubSecrets(
        `[oauth] identity capture failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
  return null;
}
