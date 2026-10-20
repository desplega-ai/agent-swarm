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

/**
 * Free-mail providers with regional domains, matched on the label before the
 * public suffix: hotmail.es, yahoo.co.uk, gmx.net and yandex.com.tr all count.
 */
const FREE_MAIL_FAMILIES = new Set([
  "aol",
  "fastmail",
  "gmail",
  "gmx",
  "googlemail",
  "hotmail",
  "icloud",
  "live",
  "msn",
  "outlook",
  "protonmail",
  "rocketmail",
  "yahoo",
  "yandex",
  "ymail",
  "zoho",
]);

/** Free-mail providers on one domain only, where the label alone is too generic. */
const FREE_MAIL_DOMAINS = new Set([
  "126.com",
  "163.com",
  "comcast.net",
  "daum.net",
  "free.fr",
  "hanmail.net",
  "hey.com",
  "libero.it",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "naver.com",
  "orange.fr",
  "pm.me",
  "proton.me",
  "qq.com",
  "rediffmail.com",
  "sina.com",
  "t-online.de",
  "tutanota.com",
  "web.de",
]);

/** Second-level labels of a country code suffix (acme.co.uk, acme.com.br). */
const SECOND_LEVEL_LABELS = new Set(["ac", "co", "com", "edu", "gov", "ne", "net", "or", "org"]);

/** Whether `host` (a normalized hostname) belongs to a public free-mail provider. */
function isFreeMailHost(host: string): boolean {
  const labels = host.split(".");
  const suffixLength = labels.length > 2 && SECOND_LEVEL_LABELS.has(labels.at(-2) ?? "") ? 2 : 1;
  // mail.yahoo.co.uk becomes yahoo.co.uk.
  const registrable = labels.slice(-(suffixLength + 1));
  return (
    FREE_MAIL_FAMILIES.has(registrable[0] ?? "") || FREE_MAIL_DOMAINS.has(registrable.join("."))
  );
}

/** The admin's email domain as a website suggestion, or null for free-mail domains. */
export function websiteSuggestion(orgDomain: string | null | undefined): string | null {
  const host = normalizeOrgWebsite(orgDomain);
  return host && !isFreeMailHost(host) ? host : null;
}
