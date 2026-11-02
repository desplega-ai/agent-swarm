/**
 * Conversion utilities between CodexOAuthCredentials (our internal type)
 * and ~/.codex/auth.json (the format the Codex CLI reads natively).
 *
 * The Codex CLI expects these native auth.json fields:
 * {
 *   "auth_mode": "chatgpt",
 *   "OPENAI_API_KEY": null,
 *   "tokens": {
 *     "id_token": "...",
 *     "access_token": "...",
 *     "refresh_token": "...",
 *     "account_id": "..."
 *   },
 *   "last_refresh": "<ISO 8601>"
 * }
 * Swarm also writes optional `expires` metadata for lossless conversion.
 *
 * Note: `id_token` is set to the `access_token` value because the token
 * exchange endpoint doesn't return a separate `id_token`. This matches
 * the `codex login --with-api-key` behavior which also doesn't have a
 * separate id_token. The Codex CLI uses id_token primarily for display
 * purposes and doesn't validate it as a separate JWT.
 */

import { codexPlanFromClaim } from "../../utils/subscription-plans.js";
import { decodeJwt, extractChatgptPlanType, extractChatgptUserId } from "./flow.js";
import type { CodexAuthJson, CodexOAuthCredentials } from "./types.js";

/**
 * Derive the slot-unique `keySuffix` that identifies a Codex OAuth pool slot
 * in `api_key_status`, the `codex-auth-watch` KV bench namespace, task
 * history, logs and failure messages: `<last 5 of chatgpt_user_id>-<slot>`.
 *
 * The slot is part of the identity because two slots signed in by the same
 * ChatGPT user carry the same `chatgpt_user_id`, and a shared suffix made
 * them share one status row and one bench marker: an auth failure on one slot
 * benched the other. Slot keys (`codex_oauth_<n>`) are stable; deleting an
 * account never renumbers the others. The user tail keeps the suffix
 * readable and gives a re-login by a different user a fresh status row.
 * `accountId` stands in for the tail when the token has no user claim.
 */
export function deriveCodexKeySuffix(accessToken: string, accountId: string, slot: number): string {
  const userId = extractChatgptUserId(accessToken);
  return `${(userId ?? accountId).slice(-5)}-${slot}`;
}

export function authJsonToCredentialSelection(auth: CodexAuthJson, slot = 0, total = 1) {
  return {
    // `selected` satisfies the CredentialSelection interface but is never read
    // for CODEX_OAUTH: creds are materialised to ~/.codex/auth.json (not env-injected),
    // and all tracking flows through `keySuffix` + `index` (never `selected`).
    selected: auth.tokens.account_id,
    index: slot,
    total,
    keySuffix: deriveCodexKeySuffix(auth.tokens.access_token, auth.tokens.account_id, slot),
    keyType: "CODEX_OAUTH",
    isRateLimitFallback: false,
    // The ChatGPT plan rides in the token itself (`chatgpt_plan_type`).
    plan: codexPlanFromClaim(extractChatgptPlanType(auth.tokens.access_token)),
  };
}

/**
 * Build the `~/.codex/auth.json` payload the Codex CLI reads natively.
 *
 * `includeRefreshToken` (default `true`) controls whether the real refresh
 * token is written into the file. For SHARED POOL slots we deliberately pass
 * `false`: OpenAI rotates a Codex refresh token on every exchange and revokes
 * the whole token family if a stale one is replayed, so a spawned Codex CLI
 * that ever refreshes straight from `auth.json` — outside the
 * `/api/oauth/refresh-locks` lock — can trigger that revocation whenever two
 * tasks share a slot. Handing the CLI an empty `refresh_token` means it
 * physically cannot rotate the family outside the lock: the config-store copy
 * keeps the real refresh token and the locked `getValidCodexOAuth` stays the
 * sole path that ever exchanges it. If the (freshly-refreshed) access token
 * still expires mid-session, the CLI's refresh simply fails and the session
 * errors out — a retryable, non-destructive outcome rather than a slot-wide
 * family revocation. Non-pool (single-credential / local dev) auth.json keeps
 * the refresh token so the CLI can self-refresh as before.
 */
export function credentialsToAuthJson(
  creds: CodexOAuthCredentials,
  opts: { includeRefreshToken?: boolean } = {},
): CodexAuthJson {
  const includeRefreshToken = opts.includeRefreshToken ?? true;
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: creds.access,
      access_token: creds.access,
      refresh_token: includeRefreshToken ? creds.refresh : "",
      account_id: creds.accountId,
    },
    last_refresh: new Date().toISOString(),
    // Swarm-only metadata keeps opaque-token round trips lossless. Codex
    // ignores this field and may drop it when it rewrites auth.json.
    expires: creds.expires,
  };
}

export function authJsonToCredentials(auth: CodexAuthJson): CodexOAuthCredentials {
  // A CLI refresh may replace the access token and discard our metadata.
  // Prefer its JWT expiry, which describes the token actually in the file.
  const exp = decodeJwt(auth.tokens.access_token)?.exp;
  const jwtExpires = typeof exp === "number" ? exp * 1000 : NaN;
  const expires =
    Number.isFinite(jwtExpires) && jwtExpires >= 0
      ? jwtExpires
      : typeof auth.expires === "number" && Number.isFinite(auth.expires)
        ? auth.expires
        : new Date(auth.last_refresh).getTime();

  return {
    access: auth.tokens.access_token,
    refresh: auth.tokens.refresh_token,
    // Legacy swarm files put expiry in last_refresh; keep that fallback
    // only when neither the token nor the explicit metadata carries it.
    expires,
    accountId: auth.tokens.account_id,
  };
}
