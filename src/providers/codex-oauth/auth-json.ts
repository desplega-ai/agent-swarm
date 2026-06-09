/**
 * Conversion utilities between CodexOAuthCredentials (our internal type)
 * and ~/.codex/auth.json (the format the Codex CLI reads natively).
 *
 * The Codex CLI expects auth.json in this exact format:
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
 *
 * Note: `id_token` is set to the `access_token` value because the token
 * exchange endpoint doesn't return a separate `id_token`. This matches
 * the `codex login --with-api-key` behavior which also doesn't have a
 * separate id_token. The Codex CLI uses id_token primarily for display
 * purposes and doesn't validate it as a separate JWT.
 */

import { extractChatgptUserId } from "./flow.js";
import type { CodexAuthJson, CodexOAuthCredentials } from "./types.js";

export function authJsonToCredentialSelection(auth: CodexAuthJson, slot = 0, total = 1) {
  // Prefer the per-grant `chatgpt_user_id` so two slots authenticated against
  // the same ChatGPT Team workspace get distinct suffixes. Fall back to
  // account_id when the JWT lacks the claim — preserves boot for any
  // unexpected token shape, at the cost of re-introducing the slot-collision
  // bug for that specific slot only. The warn is a deliberate canary.
  const userId = extractChatgptUserId(auth.tokens.access_token);
  const suffixSource = userId ?? auth.tokens.account_id;
  if (!userId) {
    console.warn(
      "[codex-oauth] No chatgpt_user_id in JWT — falling back to account_id for keySuffix derivation. " +
        "If two slots share an account, their suffixes will collide.",
    );
  }
  return {
    // `selected` satisfies the CredentialSelection interface but is never read
    // for CODEX_OAUTH: creds are materialised to ~/.codex/auth.json (not env-injected),
    // and all tracking flows through `keySuffix` + `index` (never `selected`).
    selected: auth.tokens.account_id,
    index: slot,
    total,
    keySuffix: suffixSource.slice(-5),
    keyType: "CODEX_OAUTH",
    isRateLimitFallback: false,
  };
}

export function credentialsToAuthJson(creds: CodexOAuthCredentials): CodexAuthJson {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: creds.access,
      access_token: creds.access,
      refresh_token: creds.refresh,
      account_id: creds.accountId,
    },
    last_refresh: new Date(creds.expires).toISOString(),
  };
}

export function authJsonToCredentials(auth: CodexAuthJson): CodexOAuthCredentials {
  return {
    access: auth.tokens.access_token,
    refresh: auth.tokens.refresh_token,
    expires: new Date(auth.last_refresh).getTime(),
    accountId: auth.tokens.account_id,
  };
}
