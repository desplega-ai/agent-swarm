import type { IncomingMessage, ServerResponse } from "node:http";
import { getActiveTaskCount } from "../be/db";

export function setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
  // Echo the request Origin (rather than emitting `*`) so credentialed fetches
  // — e.g. the SPA's `credentials: 'include'` calls to `/p/:id.json` and the
  // page-session cookie endpoints — pass the browser's CORS check. A wildcard
  // would force the browser to reject any credentialed cross-origin response.
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    // When credentials are involved the spec disallows wildcards in
    // Allow-Headers / Allow-Methods / Expose-Headers — they must be
    // explicit. Echo whatever the preflight asked for (defensive default
    // covers Authorization + the common app headers).
    const reqHeaders = req.headers["access-control-request-headers"];
    const askedHeaders = Array.isArray(reqHeaders) ? reqHeaders.join(", ") : reqHeaders;
    res.setHeader(
      "Access-Control-Allow-Headers",
      askedHeaders ?? "Authorization, Content-Type, X-Agent-ID, X-Requested-With",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "Content-Type, Content-Length, ETag, Location");
  } else {
    // No Origin (curl / direct browser nav) — wildcards are fine and avoid
    // breaking non-browser callers.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "*");
  }
}

export function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

export function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

/** Add capacity info to agent response */
export function agentWithCapacity<T extends { id: string; maxTasks?: number }>(
  agent: T,
): T & { capacity: { current: number; max: number; available: number } } {
  const activeCount = getActiveTaskCount(agent.id);
  const max = agent.maxTasks ?? 1;
  return {
    ...agent,
    capacity: {
      current: activeCount,
      max,
      available: Math.max(0, max - activeCount),
    },
  };
}

/** Parse JSON body from incoming request */
export async function parseBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as T;
}

/**
 * Sentinel returned by `enforceContentLengthCap` when the request exceeds the
 * provided byte cap. The caller has already received a `413` response — it
 * should stop processing the request immediately.
 */
export const BODY_TOO_LARGE = Symbol("body-too-large");

/**
 * Reject the request with `413 Payload Too Large` when its `Content-Length`
 * header exceeds `maxBytes`. Returns `BODY_TOO_LARGE` after writing the
 * response (caller short-circuits); otherwise returns `null` and processing
 * continues.
 *
 * This is a cheap pre-flight; downstream `parseBody`/streamed parsers can be
 * a second defence if a malicious client lies about Content-Length.
 *
 * Used by `/api/pages` POST/PUT to bound the per-row body size — page bodies
 * land in SQLite as a TEXT column and there is no per-instance quota yet.
 */
export function enforceContentLengthCap(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): typeof BODY_TOO_LARGE | null {
  const raw = req.headers["content-length"];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val) return null; // No header — best-effort; parseBody will still buffer.
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > maxBytes) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Payload too large (max ${maxBytes} bytes)` }));
    return BODY_TOO_LARGE;
  }
  return null;
}

/** Send JSON response */
export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Send error JSON response */
export function jsonError(res: ServerResponse, error: string, status = 400) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

/**
 * Send a 400 response for a workflow `triggerSchema` validation failure.
 * Frozen wire shape: `{ error: "TriggerSchemaError", message, details: string[] }`.
 * `details` carries the per-field validator output so callers can render
 * field-level diagnostics (FE tester, MCP, etc.).
 */
export function triggerSchemaErrorResponse(
  res: ServerResponse,
  message: string,
  details: string[],
) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "TriggerSchemaError", message, details }));
}

/**
 * Derive the API base URL for outbound-facing values (webhook URLs, OAuth
 * redirect URIs). Returns a URL with no trailing slash.
 *
 * Resolution order:
 *   1. `MCP_BASE_URL` env (canonical)
 *   2. Inbound request host — `X-Forwarded-Proto`/`X-Forwarded-Host` if behind
 *      a proxy/tunnel (ngrok), else `Host` header. Lets the URL stay correct
 *      when MCP_BASE_URL is unset and the API is reached via an arbitrary
 *      external hostname.
 *   3. `http://localhost:<PORT>` fallback
 */
export function deriveApiBaseUrl(req: IncomingMessage): string {
  const envBase = process.env.MCP_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");

  const fwdProtoRaw = req.headers["x-forwarded-proto"];
  const fwdHostRaw = req.headers["x-forwarded-host"];
  const fwdProto = Array.isArray(fwdProtoRaw) ? fwdProtoRaw[0] : fwdProtoRaw;
  const fwdHost = Array.isArray(fwdHostRaw) ? fwdHostRaw[0] : fwdHostRaw;
  const proto = fwdProto?.split(",")[0]?.trim() || "http";
  const host = fwdHost?.split(",")[0]?.trim() || req.headers.host;

  if (host) return `${proto}://${host}`;
  return `http://localhost:${process.env.PORT || "3013"}`;
}

/**
 * Build the standard OpenTelemetry HTTP *server* semantic-convention span
 * attributes that the API span doesn't already set directly.
 *
 * `http.request.method`, `url.path`, `http.route`, and
 * `http.response.status_code` are set on the span in `src/http/index.ts`;
 * this fills the remaining semconv gaps:
 *
 * - `server.address`           — request host, port stripped
 * - `url.scheme`               — `https`/`http`, honoring `X-Forwarded-Proto`
 * - `network.protocol.version` — HTTP version (`1.1`, `2`, …)
 * - `user_agent.original`      — raw `User-Agent` header
 *
 * `undefined` values are dropped by the OTel span adapter, so absent headers
 * simply omit the attribute.
 */
export function httpServerSemconvAttributes(req: IncomingMessage): {
  "server.address"?: string;
  "url.scheme": string;
  "network.protocol.version"?: string;
  "user_agent.original"?: string;
} {
  const headerValue = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  // Forwarded headers may be comma-joined by a chain of proxies — take the
  // first hop. Never used for `User-Agent`, whose value legitimately contains
  // commas (e.g. `(KHTML, like Gecko)`).
  const firstHop = (v: string | string[] | undefined): string | undefined =>
    headerValue(v)?.split(",")[0]?.trim() || undefined;

  const fwdProto = firstHop(req.headers["x-forwarded-proto"]);
  const host = firstHop(req.headers["x-forwarded-host"]) ?? headerValue(req.headers.host)?.trim();

  return {
    // Strip the trailing `:<port>` — `server.port` is a separate semconv
    // attribute we don't emit. The anchored regex leaves bracketed IPv6
    // literals intact (`[::1]:3013` → `[::1]`, bare `[::1]` unchanged).
    "server.address": host ? host.replace(/:\d+$/, "") || undefined : undefined,
    "url.scheme": fwdProto ?? "http",
    "network.protocol.version": req.httpVersion || undefined,
    "user_agent.original": headerValue(req.headers["user-agent"]),
  };
}

/**
 * Match a route pattern against HTTP method and path segments.
 *
 * @param method - HTTP method from request (e.g. "GET", "POST")
 * @param pathSegments - URL path segments (e.g. ["api", "config", "resolved"])
 * @param expectedMethod - Expected HTTP method to match
 * @param pattern - Segment patterns: string for literal match, null for dynamic param (must be truthy)
 * @param exact - If true, ensures no extra trailing segments exist (default: false)
 */
export function matchRoute(
  method: string | undefined,
  pathSegments: string[],
  expectedMethod: string,
  pattern: readonly (string | null)[],
  exact = false,
): boolean {
  if (method !== expectedMethod) return false;
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    if (seg === null) {
      if (!pathSegments[i]) return false;
    } else {
      if (pathSegments[i] !== seg) return false;
    }
  }
  if (exact && pathSegments[pattern.length]) return false;
  return true;
}
