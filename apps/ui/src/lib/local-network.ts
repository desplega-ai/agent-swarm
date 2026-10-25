// Local Network Access (LNA): Chrome 142+ and Firefox 149+ ask the user
// before a public site reaches this machine or the local network. Safari
// blocks the request. https://developer.chrome.com/blog/local-network-access
//
// Relative imports only: `bun:test` runs this from the repo root.

/** The `IPAddressSpace` values of the LNA spec that mean "not public". */
export type LocalAddressSpace = "local" | "loopback";

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function ipv4Space(host: string): LocalAddressSpace | null {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!match) return null;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 127) return "loopback";
  if (a === 10) return "local";
  if (a === 172 && b >= 16 && b <= 31) return "local";
  if (a === 192 && b === 168) return "local";
  if (a === 169 && b === 254) return "local";
  if (a === 100 && b >= 64 && b <= 127) return "local";
  return null;
}

function ipv6Space(host: string): LocalAddressSpace | null {
  if (!host.startsWith("[")) return null;
  const address = host.slice(1, -1);
  if (address === "::1") return "loopback";
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  if (/^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return "local";
  return null;
}

/**
 * The LNA address space of `url` when its host shows it without a DNS
 * lookup: `localhost` (and `*.localhost`), a loopback or private IP literal.
 * Null for any other host, and for a relative or invalid URL.
 */
export function addressSpaceOf(url: string): LocalAddressSpace | null {
  const host = hostnameOf(url);
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  return ipv4Space(host) ?? ipv6Space(host);
}

/** `url` points at this machine or the local network (also a `.local` mDNS name). */
export function isLocalNetworkUrl(url: string): boolean {
  return addressSpaceOf(url) !== null || Boolean(hostnameOf(url)?.endsWith(".local"));
}

/**
 * `init` plus the LNA `targetAddressSpace` hint for a local `url`. A hint
 * that does not match the resolved address fails the request, so only hosts
 * that `addressSpaceOf` is sure about get one (not `.local` names: the
 * browser already treats those as local). Browsers without LNA ignore it.
 */
export function withAddressSpace<T extends RequestInit>(
  url: string,
  init: T,
): T & { targetAddressSpace?: LocalAddressSpace } {
  const targetAddressSpace = addressSpaceOf(url);
  return targetAddressSpace ? { ...init, targetAddressSpace } : init;
}

/**
 * A secure public page (the hosted dashboard) calling a local URL: Chrome and
 * Firefox ask the user first, Safari blocks it. A dashboard served from this
 * machine or the local network needs no permission.
 */
export function needsLocalNetworkPermission(targetUrl: string, pageUrl: string): boolean {
  if (!isLocalNetworkUrl(targetUrl)) return false;
  return pageUrl.startsWith("https:") && !isLocalNetworkUrl(pageUrl);
}

/** Desktop or iOS Safari (WebKit with no other browser brand in the user agent). */
export function isSafari(userAgent: string): boolean {
  return (
    /safari/i.test(userAgent) && !/chrome|chromium|crios|fxios|edg|opr|android/i.test(userAgent)
  );
}
