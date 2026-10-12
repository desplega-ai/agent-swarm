/**
 * The organization's website (`SWARM_ORG_WEBSITE`), shared by the API server
 * and the dashboard. Pure: no DB, no network.
 *
 * Stored as a bare lowercase hostname. It feeds the telemetry `org_website`
 * context field, the "used by" consent, and the org logo, which the telemetry
 * proxy serves from logo.dev so the logo.dev key never leaves the proxy.
 */

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".test"];

/** Default telemetry proxy origin. */
export const TELEMETRY_PROXY_ORIGIN = "https://proxy.desplega.sh";

/**
 * Normalize what someone typed as their company website to a bare hostname:
 * lowercase, no scheme, `www.`, path, port, query or trailing dot. Null when it
 * is not a public hostname: an IP literal, `localhost`, a single label, a
 * `.local` / `.internal` style name, or anything over 253 characters.
 */
export function normalizeOrgWebsite(raw: string | null | undefined): string | null {
  let value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
  let host: string;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    host = url.hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host || host.length > 253) return null;
  if (host.startsWith("[") || IPV4.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => label.length <= 63 && LABEL.test(label))) return null;
  if (/^\d+$/.test(labels.at(-1) ?? "")) return null;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  return host;
}

/** The proxy URL that serves the logo for `host`. */
export function orgLogoUrl(host: string, origin = TELEMETRY_PROXY_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}/v1/logo?domain=${encodeURIComponent(host)}`;
}

/**
 * Whether `url` has the shape of a logo URL `orgLogoUrl` builds for `origin`:
 * the proxy origin itself, never just a matching path on another host.
 */
export function isFilledOrgLogoUrl(
  url: string | null | undefined,
  origin = TELEMETRY_PROXY_ORIGIN,
): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === new URL(origin).origin &&
      parsed.pathname === "/v1/logo" &&
      parsed.searchParams.has("domain")
    );
  } catch {
    return false;
  }
}

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "yandex.com",
  "yandex.ru",
  "mail.com",
  "zoho.com",
  "qq.com",
  "163.com",
  "hey.com",
  "fastmail.com",
]);

/** The admin's email domain as a website suggestion, or null for free-mail domains. */
export function websiteSuggestion(orgDomain: string | null | undefined): string | null {
  const host = normalizeOrgWebsite(orgDomain);
  return host && !FREE_MAIL_DOMAINS.has(host) ? host : null;
}
