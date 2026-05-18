/**
 * HMAC-SHA256 signed cookie helper for the page-session cookie.
 *
 * Scope-locked to the `pages` feature (db-backed pages) — do NOT reuse for any
 * other surface. If a second cookie use-case emerges, refactor then.
 *
 * Cookie payload: `{pageId, exp}` where `exp` is a unix seconds timestamp.
 * Wire shape: `${base64url(JSON.stringify(payload))}.${base64url(HMAC-SHA256(payload, secret))}`.
 * Secret resolution: `process.env.PAGE_SESSION_SECRET || getApiKey()`
 * — the swarm API-key fallback keeps existing dev setups working without
 * forcing a new env var. Verification is constant-time via
 * `crypto.timingSafeEqual` so we don't leak bits via signature-comparison
 * timing.
 *
 * Both functions are async because `crypto.subtle.sign` is async.
 */
import { timingSafeEqual } from "node:crypto";
import { getApiKey } from "./api-key";

export interface PageSessionPayload {
  pageId: string;
  /** Unix seconds (NOT millis). */
  exp: number;
}

/** base64url encode a byte buffer (no padding). */
function base64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // `Buffer` from `node:buffer` is available in Bun globally — encode then
  // translate `+/` → `-_` and strip `=` padding for URL-safety.
  return Buffer.from(u8)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** base64url decode → Uint8Array. Throws on malformed input (matches Buffer behaviour). */
function base64urlDecode(input: string): Uint8Array {
  // Add back `=` padding so Buffer can decode (base64 length must be a multiple of 4).
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Resolve the HMAC secret. */
function getSecret(): string {
  const secret = process.env.PAGE_SESSION_SECRET || getApiKey();
  if (!secret) {
    // Fail-closed: better to refuse to issue cookies than to mint with an
    // empty key (any attacker who learns the implementation can forge).
    throw new Error(
      "page-session: neither PAGE_SESSION_SECRET nor swarm API key is set; refusing to sign/verify",
    );
  }
  return secret;
}

/** Import the HMAC key for crypto.subtle. */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Sign a page-session payload. Returns the cookie value (no `Set-Cookie` shell).
 * Caller is responsible for attaching cookie attributes (HttpOnly, Path, etc.).
 */
export async function signPageSession(payload: PageSessionPayload): Promise<string> {
  const secret = getSecret();
  const key = await importHmacKey(secret);
  const enc = new TextEncoder();
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(enc.encode(payloadJson));
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  const sigB64 = base64urlEncode(sigBuf);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a signed page-session token. Returns the parsed payload on success or
 * `null` on any failure — bad shape, signature mismatch, expired, malformed
 * JSON, etc. Signature comparison is constant-time.
 *
 * Caller MUST treat `null` as "no session" — do NOT log the token (it may
 * carry a valid signature an attacker provided). If a tampered cookie is
 * observed and the caller chooses to log, redact via `scrubSecrets` first.
 */
export async function verifyPageSession(
  token: string | undefined | null,
): Promise<PageSessionPayload | null> {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  // Reject anything that doesn't split into exactly two parts.
  if (dot <= 0 || dot === token.length - 1) return null;
  if (token.indexOf(".", dot + 1) !== -1) return null;

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }

  let providedSig: Uint8Array;
  try {
    providedSig = base64urlDecode(sigB64);
  } catch {
    return null;
  }

  let key: CryptoKey;
  try {
    key = await importHmacKey(secret);
  } catch {
    return null;
  }

  const enc = new TextEncoder();
  let expectedSig: Uint8Array;
  try {
    expectedSig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
  } catch {
    return null;
  }

  // Length-check FIRST — timingSafeEqual throws if lengths differ.
  if (providedSig.length !== expectedSig.length) return null;
  // Constant-time compare.
  try {
    if (!timingSafeEqual(providedSig, expectedSig)) return null;
  } catch {
    return null;
  }

  // Parse + validate payload.
  let payloadJson: string;
  try {
    payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64));
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { pageId?: unknown }).pageId !== "string" ||
    typeof (payload as { exp?: unknown }).exp !== "number"
  ) {
    return null;
  }

  const parsed = payload as PageSessionPayload;
  const nowSec = Math.floor(Date.now() / 1000);
  if (parsed.exp < nowSec) return null;

  return parsed;
}

/**
 * Parse the `Cookie` request header for a single named cookie value.
 * Returns `undefined` if the header is missing, empty, or doesn't contain the
 * named cookie. Whitespace tolerant; matches the first occurrence.
 */
export function parseCookieHeader(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const header = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  // Pre-escape regex metacharacters in `name` for safety (we only pass known
  // literals today, but cheap insurance).
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`);
  const match = header.match(re);
  return match ? match[1] : undefined;
}

/**
 * One-shot helper: pull `page_session` out of a request's `Cookie` header and
 * verify it. Returns the parsed payload on success, `null` on any failure
 * (no cookie, malformed, bad signature, expired, etc.).
 *
 * Shared by `/@swarm/api/*` (`src/http/page-proxy.ts`) and the authed `/p/:id`
 * branch (`src/http/pages-public.ts`) so both call sites converge on the same
 * verification semantics.
 *
 * Accepts an object with a `headers.cookie` field — duck-typed to keep this
 * helper test-friendly without dragging `node:http` types into the utility.
 */
export async function extractAndVerifyCookie(req: {
  headers: { cookie?: string | string[] | undefined };
}): Promise<PageSessionPayload | null> {
  const token = parseCookieHeader(req.headers.cookie, "page_session");
  if (!token) return null;
  return verifyPageSession(token);
}

// ───────────────────────────────────────────────────────────────────────────
// Cookie issuance helper
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cookie lifetime in seconds. 1 hour. Mirrors `PAGE_SESSION_TTL_SECONDS` in
 * `src/http/pages.ts` (intentionally duplicated here to keep the helper
 * standalone; if the value diverges anywhere, that's the bug).
 */
const PAGE_SESSION_TTL_SECONDS = 3600;

/**
 * Mint a signed page-session token + build the `Set-Cookie` header value for
 * `pageId`. Shared by the bearer-authed launch endpoint (`src/http/pages.ts`)
 * and the password-flow inline mint (`src/http/pages-public.ts`).
 *
 * - `dev=true` → `SameSite=Lax` without `Secure` (works on http://localhost).
 * - `dev=false` → `SameSite=None; Secure` (cross-site iframe embedding in prod).
 *
 * The caller is responsible for setting `Set-Cookie` on the response — this
 * helper only builds the string. TTL is 1 hour; renewed on every issuance.
 */
export async function issuePageSessionCookie(
  pageId: string,
  opts: { dev: boolean },
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + PAGE_SESSION_TTL_SECONDS;
  const token = await signPageSession({ pageId, exp });
  const attrs = [
    `page_session=${token}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${PAGE_SESSION_TTL_SECONDS}`,
  ];
  if (opts.dev) {
    attrs.push("SameSite=Lax");
  } else {
    attrs.push("SameSite=None");
    attrs.push("Secure");
  }
  return attrs.join("; ");
}
