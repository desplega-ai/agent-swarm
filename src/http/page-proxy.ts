import type { IncomingMessage, ServerResponse } from "node:http";
import { getPage } from "../be/db";
import { getApiKey } from "../utils/api-key";
import { extractAndVerifyCookie } from "../utils/page-session";
import { route } from "./route-def";
import { jsonError } from "./utils";

/**
 * `/@swarm/api/*` proxy. Cookie-gated equivalent of the artifact-sdk proxy
 * (src/artifact-sdk/server.ts:42-69), but lives on the MAIN API server and
 * authenticates via the page-session cookie instead of basic-auth + a per-
 * artifact tunnel.
 *
 * Flow:
 *   1. Browser hits `/@swarm/api/<rest>` from inside an iframe of `/p/:id`.
 *   2. We parse the `page_session` cookie, verify HMAC + expiry.
 *   3. Look up the page; map `agentId` → `X-Agent-ID`.
 *   4. Re-issue the request to the same API server's `/api/<rest>` with
 *      `Authorization: Bearer ${API_KEY}` and `X-Agent-ID: ${page.agentId}`
 *      injected server-side. The bearer NEVER touches the browser.
 *
 * Cookie IS the auth — this route opts out of the global bearer gate via
 * `route({ auth: { apiKey: false } })`. Unknown paths fail closed (the
 * `isPublicRoute` check defaults to bearer-required), so we must declare the
 * route here even though we don't use route().match() for the actual
 * dispatch (we use a startsWith check below — segment-based matching gets
 * unwieldy for an arbitrary suffix).
 */

// Registered purely so the global bearer-gate (`isPublicRoute`) skips the
// API-key check for /@swarm/api/* requests. The handler below does its own
// cookie validation. The path pattern uses a single dynamic segment as a
// stand-in; the actual route accepts ANY suffix and is matched manually via
// `req.url.startsWith("/@swarm/api/")` for clarity.
route({
  method: "get",
  path: "/@swarm/api/{path}",
  pattern: ["@swarm", "api", null],
  exact: false,
  summary: "Cookie-gated proxy to the swarm API (used by db-backed page iframes)",
  tags: ["Pages"],
  responses: {
    200: { description: "Proxied response from the underlying /api/* endpoint" },
    401: { description: "No or invalid page-session cookie" },
    404: { description: "Page referenced by the cookie no longer exists" },
  },
  auth: { apiKey: false },
});
route({
  method: "post",
  path: "/@swarm/api/{path}",
  pattern: ["@swarm", "api", null],
  exact: false,
  summary: "Cookie-gated proxy to the swarm API (POST)",
  tags: ["Pages"],
  responses: {
    200: { description: "Proxied response" },
    401: { description: "No or invalid page-session cookie" },
  },
  auth: { apiKey: false },
});
route({
  method: "put",
  path: "/@swarm/api/{path}",
  pattern: ["@swarm", "api", null],
  exact: false,
  summary: "Cookie-gated proxy to the swarm API (PUT)",
  tags: ["Pages"],
  responses: {
    200: { description: "Proxied response" },
    401: { description: "No or invalid page-session cookie" },
  },
  auth: { apiKey: false },
});
route({
  method: "delete",
  path: "/@swarm/api/{path}",
  pattern: ["@swarm", "api", null],
  exact: false,
  summary: "Cookie-gated proxy to the swarm API (DELETE)",
  tags: ["Pages"],
  responses: {
    200: { description: "Proxied response" },
    401: { description: "No or invalid page-session cookie" },
  },
  auth: { apiKey: false },
});
route({
  method: "patch",
  path: "/@swarm/api/{path}",
  pattern: ["@swarm", "api", null],
  exact: false,
  summary: "Cookie-gated proxy to the swarm API (PATCH)",
  tags: ["Pages"],
  responses: {
    200: { description: "Proxied response" },
    401: { description: "No or invalid page-session cookie" },
  },
  auth: { apiKey: false },
});

const PROXY_PREFIX = "/@swarm/api/";

/**
 * Explicit allowlist of `/api/*` routes the page-proxy may forward to. This
 * MUST stay in sync with the domains the injected browser SDK actually
 * exposes (`src/artifact-sdk/browser-sdk.ts` — tasks, agents, events, memory,
 * repos, schedules, approvalRequests, assets, kv). A page-session cookie is
 * held by anyone who can view a page (public pages have no auth at all), so
 * the proxy must NOT forward arbitrary `/api/*` paths with the operator
 * bearer attached — that would make every cookie holder an operator for the
 * entire API surface. `null` marks a single-segment wildcard (path param).
 */
const PROXY_ALLOWLIST: ReadonlyArray<{ method: string; segments: ReadonlyArray<string | null> }> = [
  { method: "GET", segments: ["tasks"] },
  { method: "POST", segments: ["tasks"] },
  { method: "GET", segments: ["tasks", null] },
  { method: "POST", segments: ["tasks", null, "progress"] },
  { method: "GET", segments: ["agents"] },
  { method: "GET", segments: ["agents", null] },
  { method: "POST", segments: ["events"] },
  { method: "GET", segments: ["events"] },
  { method: "POST", segments: ["events", "batch"] },
  { method: "GET", segments: ["events", "counts"] },
  { method: "POST", segments: ["memory", "search"] },
  { method: "GET", segments: ["memory", "list"] },
  { method: "GET", segments: ["memory", null] },
  { method: "POST", segments: ["memory", "rate"] },
  { method: "GET", segments: ["repos"] },
  { method: "POST", segments: ["repos"] },
  { method: "GET", segments: ["repos", null] },
  { method: "PUT", segments: ["repos", null] },
  { method: "DELETE", segments: ["repos", null] },
  { method: "GET", segments: ["schedules"] },
  { method: "POST", segments: ["schedules"] },
  { method: "GET", segments: ["schedules", null] },
  { method: "PUT", segments: ["schedules", null] },
  { method: "DELETE", segments: ["schedules", null] },
  { method: "POST", segments: ["schedules", null, "run"] },
  { method: "GET", segments: ["approval-requests"] },
  { method: "POST", segments: ["approval-requests"] },
  { method: "GET", segments: ["approval-requests", null] },
  { method: "POST", segments: ["approval-requests", null, "respond"] },
  { method: "GET", segments: ["assets"] },
  { method: "GET", segments: ["assets", "key-audit"] },
  { method: "POST", segments: ["assets", "mappings"] },
  { method: "PATCH", segments: ["assets", null, null, "key"] },
  { method: "GET", segments: ["kv"] },
  { method: "GET", segments: ["kv", null] },
  { method: "PUT", segments: ["kv", null] },
  { method: "DELETE", segments: ["kv", null] },
  { method: "POST", segments: ["kv", null, "incr"] },
  // Explicit-namespace KV variants (`/kv/_/:namespace/...`). Safe to
  // forward: `X-Page-Id` (set below, unconditionally, by this proxy) is the
  // highest-priority namespace source in src/http/kv.ts, so these always
  // resolve to the page's own `task:page:<id>` namespace regardless of what
  // namespace the URL names — the URL argument can never actually reach
  // another agent's KV data.
  { method: "GET", segments: ["kv", "_", null] },
  { method: "GET", segments: ["kv", "_", null, null] },
  { method: "PUT", segments: ["kv", "_", null, null] },
  { method: "DELETE", segments: ["kv", "_", null, null] },
  { method: "POST", segments: ["kv", "_", null, null, "incr"] },
];

/**
 * Split the proxied suffix (everything after `/@swarm/api/`) into decoded
 * path segments, rejecting anything that smells like path traversal or an
 * attempt to smuggle an extra segment past the allowlist via percent-encoding
 * (e.g. `%2e%2e`, `%2f`). Returns `null` on any rejection.
 */
function decodeProxySegments(suffix: string): string[] | null {
  if (suffix.length === 0) return [];
  const rawSegments = suffix.split("/");
  const decoded: string[] = [];
  for (const raw of rawSegments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null; // malformed percent-encoding
    }
    if (seg.length === 0) return null; // empty segment (e.g. "//") — reject
    if (seg === "." || seg === "..") return null; // path traversal
    // A decoded segment containing a slash or backslash means the raw
    // segment smuggled an encoded separator (`%2F`, `%5C`) past the naive
    // `split("/")` above — reject rather than let it re-introduce a segment
    // boundary the allowlist match below never saw.
    if (seg.includes("/") || seg.includes("\\")) return null;
    decoded.push(seg);
  }
  return decoded;
}

/** True if `method` + decoded `segments` match an allowlisted route. */
function isProxyAllowed(method: string, segments: string[]): boolean {
  return PROXY_ALLOWLIST.some((route) => {
    if (route.method !== method) return false;
    if (route.segments.length !== segments.length) return false;
    return route.segments.every((expected, i) => expected === null || expected === segments[i]);
  });
}

/**
 * Handle `/@swarm/api/*` requests. Returns `true` if the request was handled
 * (response sent), `false` if not — caller continues to the next handler.
 *
 * Place BEFORE `handlePages` in the central `handlers` array — `/@swarm/api/*`
 * does not overlap `/api/pages/*` segment-wise (different first segment), but
 * we keep the ordering explicit.
 */
export async function handlePageProxy(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith(PROXY_PREFIX)) return false;

  // Strip query string for cookie/path checks, but preserve it for the
  // forwarded URL so callers like `/me?include=inbox` still work.
  const queryIdx = url.indexOf("?");
  const pathPart = queryIdx === -1 ? url : url.slice(0, queryIdx);
  const queryPart = queryIdx === -1 ? "" : url.slice(queryIdx);

  // ─── Route allowlist ──────────────────────────────────────────────────────
  // Reject anything outside the documented browser-SDK surface before doing
  // any auth work — this also rejects path-traversal and absolute-URL-form
  // suffixes (they can never decode into an allowlisted segment sequence).
  const method = (req.method ?? "GET").toUpperCase();
  const suffix = pathPart.slice(PROXY_PREFIX.length);
  const segments = decodeProxySegments(suffix);
  if (!segments || !isProxyAllowed(method, segments)) {
    jsonError(res, "not found", 404);
    return true;
  }

  // ─── Cookie validation ────────────────────────────────────────────────────
  const payload = await extractAndVerifyCookie(req);
  if (!payload) {
    jsonError(res, "no page session", 401);
    return true;
  }

  const page = getPage(payload.pageId);
  if (!page) {
    // Cookie was issued before the page was deleted. Treat as a stale session
    // rather than 404 so the client knows to refresh / re-launch.
    jsonError(res, "page session no longer valid", 401);
    return true;
  }

  // ─── Rewrite + forward ─────────────────────────────────────────────────────
  // `/@swarm/api/me` → `/api/me`. Preserve query string.
  //
  // This is an IN-PROCESS proxy — we always dispatch to the same server we're
  // running in. We deliberately do NOT use `deriveApiBaseUrl(req)`: that would
  // honour `MCP_BASE_URL` (which may be an ngrok tunnel or other external host
  // pointing back at us), forcing a network round-trip through the public
  // surface and breaking when `localhost:<PORT>` is reachable but the public
  // URL isn't (test envs, offline dev, restrictive networks).
  const rewrittenPath = pathPart.replace(PROXY_PREFIX, "/api/");
  const port = process.env.PORT || "3013";
  const baseUrl = `http://127.0.0.1:${port}`;
  const targetUrl = `${baseUrl}${rewrittenPath}${queryPart}`;

  const apiKey = getApiKey();
  // `X-Page-Id` is the trust anchor for page-scoped KV: only the page-proxy
  // ever sets it (any external `X-Page-Id` header is dropped because we don't
  // forward the original headers). The KV handler treats this as the highest-
  // priority namespace source so a page can't escape `task:page:<own>`.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "X-Agent-ID": page.agentId,
    "X-Page-Id": page.id,
  };

  // Forward content-type / accept verbatim for non-GET so JSON bodies work.
  const reqContentType = req.headers["content-type"];
  if (reqContentType) {
    headers["Content-Type"] = Array.isArray(reqContentType) ? reqContentType[0]! : reqContentType;
  }
  const reqAccept = req.headers.accept;
  if (reqAccept) {
    headers.Accept = Array.isArray(reqAccept) ? reqAccept[0]! : reqAccept;
  }

  // Pull the body if there is one. We DO buffer here — page traffic is
  // expected to be small JSON payloads, and streaming would complicate cookie
  // failure-mode handling. `method` was already resolved above for the
  // allowlist check.
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length > 0) body = Buffer.concat(chunks);
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      // Prevent the runtime from following redirects — surface them to the
      // caller as-is so the SDK sees the same response it would direct-fetching.
      redirect: "manual",
    });
  } catch (err) {
    // Don't echo the underlying error to the client (could leak target URL
    // shape under some env-var typos). Log to server, send generic 502.
    console.error("[page-proxy] upstream fetch failed:", err);
    jsonError(res, "upstream error", 502);
    return true;
  }

  // Pipe upstream response back. Preserve status + content-type.
  const upstreamCt = upstream.headers.get("content-type");
  if (upstreamCt) res.setHeader("Content-Type", upstreamCt);

  // Copy a small allowlist of useful headers. Don't blanket-forward — upstream
  // may include `Set-Cookie` we don't want to re-emit, etc.
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) res.setHeader("Cache-Control", cacheControl);

  res.writeHead(upstream.status);
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
  return true;
}
