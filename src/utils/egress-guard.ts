import { lookup } from "node:dns/promises";

/**
 * Outbound-request guard shared by the OAuth/MCP fetchers (`assertUrlSafe`)
 * and the quickjs script executor (`guardedFetch`).
 *
 * `assertUrlSafe` checks the URL string only. `guardedFetch` also resolves the
 * hostname, so a public name that points at a private address is refused, and
 * it re-checks every redirect hop.
 */

// ─── Address classification ──────────────────────────────────────────────────

/** Canonical dotted-quad IPv4 to a 32-bit number, or null. */
function parseIPv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

// [network, prefix length] pairs: unspecified, private, CGNAT, loopback,
// link-local (cloud metadata), IETF protocol, benchmarking, multicast, reserved.
const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map(([network, bits]) => {
  const size = 2 ** (32 - bits);
  return { start: parseIPv4(network) as number, size };
});

function isBlockedIPv4Number(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some(({ start, size }) => value >= start && value < start + size);
}

/** IPv6 text (no brackets, no zone) to 16 bytes, or null. */
function parseIPv6(host: string): Uint8Array | null {
  if (!host.includes(":")) return null;
  let text = host;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    tail.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
    // Keep a `::` that sat right before the IPv4 part ("::1.2.3.4").
    const prefix = text.slice(0, lastColon);
    text = prefix.endsWith(":") ? `${prefix}:` : prefix;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  let groups: number[];
  if (halves.length === 2) {
    if (known > 7) return null;
    groups = [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
  } else {
    if (known !== 8) return null;
    groups = [...head, ...tail];
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function embeddedIPv4(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function isBlockedIPv6Bytes(bytes: Uint8Array): boolean {
  const zeroUntil = (end: number) => bytes.subarray(0, end).every((byte) => byte === 0);
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  // ::/96 covers :: (unspecified), ::1 (loopback) and the deprecated IPv4-compatible forms.
  if (zeroUntil(12)) return true;
  // ::ffff:0:0/96, IPv4-mapped.
  if (zeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIPv4Number(embeddedIPv4(bytes, 12));
  }
  // 64:ff9b::/96 NAT64 maps the embedded IPv4; 64:ff9b:1::/48 is local-use.
  if (b0 === 0x00 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (bytes[4] === 0 && bytes[5] === 1) return true;
    return isBlockedIPv4Number(embeddedIPv4(bytes, 12));
  }
  // 2002::/16 6to4 embeds an IPv4 in bytes 2-5.
  if (b0 === 0x20 && b1 === 0x02) return isBlockedIPv4Number(embeddedIPv4(bytes, 2));
  // 100::/64 discard-only.
  if (b0 === 0x01 && b1 === 0x00 && bytes.subarray(2, 8).every((byte) => byte === 0)) return true;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b0 === 0xff) return true; // ff00::/8 multicast
  return false;
}

function stripBrackets(host: string): string {
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const zone = unbracketed.indexOf("%");
  return zone === -1 ? unbracketed : unbracketed.slice(0, zone);
}

/** True for an IP literal (v4 or v6, bracketed or not) in a blocked range. */
export function isPrivateAddress(address: string): boolean {
  const host = stripBrackets(address.trim().toLowerCase());
  const v4 = parseIPv4(host);
  if (v4 !== null) return isBlockedIPv4Number(v4);
  const v6 = parseIPv6(host);
  return v6 !== null && isBlockedIPv6Bytes(v6);
}

function isIPv4Literal(host: string): boolean {
  return parseIPv4(host) !== null;
}

function isIPv6Literal(host: string): boolean {
  return parseIPv6(stripBrackets(host)) !== null;
}

function isLoopbackName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

// ─── URL string guard ────────────────────────────────────────────────────────

export interface SsrfGuardOptions {
  /** Allow loopback and RFC1918 hosts (dev / self-hosting). Opt-in only. */
  allowPrivateHosts?: boolean;
  /** Allow http:// URLs (dev). In production only https:// is accepted. */
  allowInsecure?: boolean;
}

/**
 * Parses `rawUrl` and refuses unsupported protocols, insecure http (unless
 * allowed), and loopback/private/link-local hosts (unless allowed). Checks the
 * string only: the WHATWG parser normalizes decimal, octal and hex IPv4 forms
 * first, but a public name that resolves to a private address passes. Use
 * `guardedFetch` where that matters.
 */
export function assertUrlSafe(rawUrl: string, opts: SsrfGuardOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  const allowPrivate = opts.allowPrivateHosts === true;
  const allowInsecure = opts.allowInsecure === true;

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new Error(`Refusing insecure (http://) URL in production: ${rawUrl}`);
  }

  const host = parsed.hostname;
  if (!host) {
    throw new Error(`Missing hostname: ${rawUrl}`);
  }
  if (allowPrivate) return parsed;

  if (isLoopbackName(host)) {
    throw new Error(`Refusing loopback hostname: ${host}`);
  }
  if (isIPv4Literal(host) && isPrivateAddress(host)) {
    throw new Error(`Refusing private IPv4 host: ${host}`);
  }
  if (isIPv6Literal(host) && isPrivateAddress(host)) {
    throw new Error(`Refusing private IPv6 host: ${host}`);
  }

  return parsed;
}

// ─── Fetch guard ─────────────────────────────────────────────────────────────

export type EgressPolicy = {
  /** Allow private, loopback, link-local and other non-public destinations. */
  allowPrivate: boolean;
  /**
   * `host[:port]` patterns; a leading `*.` matches any subdomain. When set,
   * only matching hosts are reachable, public or private. `null` = any public host.
   */
  allowlist: string[] | null;
};

export type GuardedFetchOptions = {
  policy: EgressPolicy;
  /** Resolves a hostname to its addresses. Defaults to `node:dns` lookup. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** A destination the host itself is calling (for example the swarm API). Skips the policy. */
  isTrusted?: (url: URL) => boolean;
};

export class EgressDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressDeniedError";
  }
}

export const MAX_REDIRECTS = 5;
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Dropped on a cross-origin redirect, as the Fetch standard does for Authorization.
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

type HopRequest = { method: string; headers: Headers; body: RequestInit["body"] | undefined };

/**
 * The request to send to `to` after a `status` redirect from `from`: 303 (and
 * 301/302 after POST) become a bodiless GET, and a cross-origin hop drops
 * credential headers.
 */
export function nextHopRequest(
  status: number,
  from: URL,
  to: URL,
  request: HopRequest,
): HopRequest {
  const headers = new Headers(request.headers);
  if (to.origin !== from.origin) {
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  }
  const method = request.method.toUpperCase();
  const toGet =
    status === 303 ? method !== "HEAD" : (status === 301 || status === 302) && method === "POST";
  if (!toGet) return { method, headers, body: request.body };
  headers.delete("content-type");
  headers.delete("content-length");
  return { method: "GET", headers, body: undefined };
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

function matchesAllowlist(url: URL, allowlist: string[]): boolean {
  const host = stripBrackets(url.hostname.toLowerCase()).replace(/\.$/, "");
  const port = effectivePort(url);
  return allowlist.some((rawEntry) => {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    // `[v6]:port`, `host:port`, or a bare host / v6 literal.
    let entryHost = entry;
    let entryPort: string | null = null;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      entryHost = bracketed[1] ?? "";
      entryPort = bracketed[2] ?? null;
    } else if ((entry.match(/:/g) ?? []).length === 1) {
      const [name, portText] = entry.split(":");
      entryHost = name ?? "";
      entryPort = portText ?? null;
    }
    if (entryPort !== null && entryPort !== port) return false;
    if (entryHost.startsWith("*.")) {
      const suffix = entryHost.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === entryHost;
  });
}

/**
 * Throws `EgressDeniedError` when `url` may not be fetched under `options`.
 * For a hostname it had to resolve, returns the checked address the request
 * must connect to; otherwise null (the URL is used as is).
 */
export async function assertEgressAllowed(
  url: URL,
  options: GuardedFetchOptions,
): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // data:/blob: never leave the process.
    if (url.protocol === "data:" || url.protocol === "blob:") return null;
    throw new EgressDeniedError(`Script egress refused: unsupported protocol ${url.protocol}`);
  }
  if (options.isTrusted?.(url)) return null;

  const { policy } = options;
  if (policy.allowlist && policy.allowlist.length > 0) {
    if (matchesAllowlist(url, policy.allowlist)) return null;
    throw new EgressDeniedError(
      `Script egress refused: ${url.host} is not in SCRIPT_EGRESS_ALLOWLIST`,
    );
  }
  if (policy.allowPrivate) return null;

  const host = stripBrackets(url.hostname);
  const denied = () =>
    new EgressDeniedError(
      `Script egress refused: ${url.host} is a private or loopback address. Add it to SCRIPT_EGRESS_ALLOWLIST or set SCRIPT_EGRESS_ALLOW_PRIVATE=true`,
    );
  if (isLoopbackName(host)) throw denied();
  if (isIPv4Literal(host) || isIPv6Literal(host)) {
    if (isPrivateAddress(host)) throw denied();
    return null;
  }
  let addresses: string[];
  try {
    addresses = await (options.resolve ?? defaultResolve)(host);
  } catch (error) {
    throw new EgressDeniedError(
      `Script egress refused: could not resolve ${host} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (addresses.length === 0) {
    throw new EgressDeniedError(`Script egress refused: ${host} resolved to no address`);
  }
  // Deny when ANY answer is private: a mixed answer set is a rebinding setup.
  if (addresses.some(isPrivateAddress)) throw denied();
  return addresses.find(isIPv4Literal) ?? (addresses[0] as string);
}

/**
 * The URL and init that connect to `address` instead of resolving `url` again.
 * The Host header, TLS SNI and certificate hostname check stay on `url`'s name.
 */
export function pinToAddress(url: URL, address: string, init: RequestInit): [URL, RequestInit] {
  const target = new URL(url.href);
  target.hostname = isIPv6Literal(address) ? `[${stripBrackets(address)}]` : address;
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", url.host);
  const pinned: RequestInit & { tls?: Record<string, unknown> } = { ...init, headers };
  if (url.protocol === "https:") {
    const callerTls = (init as { tls?: Record<string, unknown> }).tls;
    pinned.tls = { ...callerTls, serverName: url.hostname.replace(/\.$/, "") };
  }
  return [target, pinned];
}

/**
 * Largest stream body held in memory to send again on a 307/308 hop. A longer
 * stream is sent as it is read and cannot be resent, so a request holds at
 * most about this much extra, however large its body.
 */
export const MAX_REPLAY_BODY_BYTES = 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(
      `Cannot resend a streamed request body over ${limitBytes / (1024 * 1024)} MiB on a 307/308 redirect: it is sent as it is read, not kept in memory. Send a smaller or non-streamed body, or use redirect: "manual"`,
    );
    this.name = "RequestBodyTooLargeError";
  }
}

function chunkBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError("Request body stream yielded a chunk that is not bytes or a string");
}

export type ReplayableBody = {
  body: RequestInit["body"] | undefined;
  /** False for a stream over the cap: a redirect that resends it must fail. */
  replayable: boolean;
};

/**
 * Prepares a body for a fetch that may follow a 307/308 hop. A stream is read
 * into memory up to `maxBytes`; a longer one is passed on unbuffered (the read
 * part first) and marked not replayable. Abort and a failing stream reject and
 * cancel the source.
 */
export async function replayableBody(
  body: RequestInit["body"] | undefined,
  signal?: AbortSignal | null,
  maxBytes = MAX_REPLAY_BODY_BYTES,
): Promise<ReplayableBody> {
  if (!(body instanceof ReadableStream)) return { body: body ?? undefined, replayable: true };
  const reader = body.getReader();
  // Cancelling the reader settles a pending read, so an abort never waits on the source.
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overCap = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      const bytes = chunkBytes(value);
      size += bytes.byteLength;
      chunks.push(bytes);
      if (size > maxBytes) {
        overCap = true;
        break;
      }
    }
  } catch (error) {
    // Start cancellation but never wait on the source's cleanup to reject.
    reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (overCap) {
    // The fetch reads the rest straight from the source and cancels it on abort.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks.splice(0)) controller.enqueue(chunk);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(chunkBytes(value));
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return { body: stream, replayable: false };
  }
  reader.releaseLock();
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: out, replayable: true };
}

/**
 * Wraps `baseFetch` so every request, and every redirect hop, passes
 * `assertEgressAllowed`, and a checked hostname connects to the address that
 * was checked. Redirects are followed manually (at most 5). A cross-origin hop
 * drops credential headers. `redirect: "manual"` and `"error"` keep their
 * usual meaning.
 */
export function createGuardedFetch(
  baseFetch: typeof fetch,
  options: GuardedFetchOptions,
): typeof fetch {
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    let url = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    );
    const mode = init?.redirect ?? request?.redirect ?? "follow";
    let method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    let headers = new Headers(init?.headers ?? request?.headers);
    const signal = init?.signal ?? request?.signal;
    let body: RequestInit["body"] | undefined = init?.body ?? (request ? request.body : undefined);
    let replayable = true;
    if (mode === "follow") ({ body, replayable } = await replayableBody(body, signal));

    for (let hop = 0; ; hop++) {
      const address = await assertEgressAllowed(url, options);
      const hopInit: RequestInit = {
        ...init,
        method,
        headers,
        body,
        signal,
        redirect: "manual",
      };
      const response = address
        ? await baseFetch(...pinToAddress(url, address, hopInit))
        : await baseFetch(url, hopInit);
      // A pinned request reports the address it connected to; show the name.
      if (address) Object.defineProperty(response, "url", { value: url.href });
      if (!REDIRECT_STATUSES.has(response.status) || mode === "manual") return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (mode === "error")
        throw new TypeError(`fetch redirect refused (redirect: "error"): ${url.href}`);
      if (hop >= MAX_REDIRECTS) {
        throw new EgressDeniedError(`Script egress refused: more than ${MAX_REDIRECTS} redirects`);
      }
      await response.body?.cancel().catch(() => {});
      const next = new URL(location, url);
      ({ method, headers, body } = nextHopRequest(response.status, url, next, {
        method,
        headers,
        body,
      }));
      if (!replayable && body !== undefined)
        throw new RequestBodyTooLargeError(MAX_REPLAY_BODY_BYTES);
      url = next;
    }
  };
  return Object.assign(guarded, { preconnect: baseFetch.preconnect }) as typeof fetch;
}

/** Parses the comma-separated `SCRIPT_EGRESS_ALLOWLIST` value. Empty = null. */
export function parseEgressAllowlist(value: string | undefined): string[] | null {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : null;
}

/** Returns an error message for an invalid allowlist entry, else null. */
export function validateEgressAllowlist(value: string): string | null {
  for (const entry of parseEgressAllowlist(value) ?? []) {
    const ok =
      /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(
        entry,
      ) ||
      /^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(entry) ||
      /^[0-9a-f:]*:[0-9a-f:.]*$/i.test(entry);
    if (!ok) {
      return `Invalid SCRIPT_EGRESS_ALLOWLIST entry "${entry}" (use comma-separated host[:port] patterns; a leading *. matches subdomains)`;
    }
  }
  return null;
}
