/**
 * Linear host resolver: the web base (OAuth consent page) and the API base (GraphQL,
 * OAuth token and revoke).
 *
 * `LINEAR_URL` (default https://linear.app) and `LINEAR_API_URL` (default
 * https://api.linear.app) exist so the black-box E2E suite can point the integration at a
 * local Linear emulator. Both are deployment-env only (reserved in swarm-config-guard):
 * the API base receives the OAuth client secret and every access token.
 *
 * Env is read on every call (no cache) so a restart with new env takes effect.
 */

const DEFAULT_WEB_URL = "https://linear.app";
const DEFAULT_API_URL = "https://api.linear.app";

function base(name: "LINEAR_URL" | "LINEAR_API_URL", fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
      return raw.replace(/\/+$/, "");
    }
  } catch {}
  // The raw value is never echoed: a mistyped URL can carry a token.
  console.warn(
    `[Linear] ${name} is not a valid http(s) URL without credentials; using ${fallback}`,
  );
  return fallback;
}

/** `path` starts with `/`, e.g. `linearApiUrl("/graphql")`. */
export function linearApiUrl(path: string): string {
  return `${base("LINEAR_API_URL", DEFAULT_API_URL)}${path}`;
}

/** `path` starts with `/`, e.g. `linearWebUrl("/oauth/authorize")`. */
export function linearWebUrl(path: string): string {
  return `${base("LINEAR_URL", DEFAULT_WEB_URL)}${path}`;
}
