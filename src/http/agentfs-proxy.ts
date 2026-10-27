import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { getApiKey } from "../utils/api-key";
import { isAgentFsProxyEnabled } from "../utils/constants";
import { resolveHttpRequestAuth } from "./auth";
import { clientIp, createIpRateLimiter } from "./ip-rate-limit";
import { route } from "./route-def";
import { jsonError, parseBody, RequestBodyTooLargeError } from "./utils";

/**
 * Streaming pass-through to the agent-fs server at AGENT_FS_API_URL, active
 * only when AGENT_FS_PROXY is on:
 *
 * - `/agentfs/*` -> agent-fs `/*` (the API Comb calls from the browser);
 * - `/share/*` and `/site/*` -> agent-fs `/share/*` and `/site/*` unchanged.
 *   agent-fs share pages embed root-absolute `/share/<token>/raw` URLs and
 *   redirect to `/site/<token>/`, so they 404 behind the `/agentfs` prefix alone.
 *
 * agent-fs enforces its own `af_` bearer. The one swarm check is on
 * `POST /agentfs/auth/register` (see `checkRegister`). Only an
 * `Authorization: Bearer af_...` credential is forwarded (never a swarm API key
 * or an `aswt_` token), plus an allowlist of other request headers (never
 * Cookie or X-Agent-ID). On `/agentfs/*` the upstream CORS headers are dropped
 * (the swarm's own setCorsHeaders applies); on `/share/*` and `/site/*` they
 * are kept, because sandboxed site pages run in an opaque origin and need
 * agent-fs's `Access-Control-Allow-Origin: *`. Both bodies are streamed.
 */

const API_PREFIX = "/agentfs";
const PUBLIC_PREFIXES = ["/share/", "/site/"];

function upstreamBase(): string | null {
  const v = process.env.AGENT_FS_API_URL?.trim().replace(/\/+$/, "");
  return v || null;
}

/** Request headers forwarded as is. `authorization` is handled separately. */
const REQUEST_HEADER_ALLOWLIST = [
  "content-type",
  // Framing for streamed uploads: agent-fs checks it against its upload cap.
  "content-length",
  "accept",
  "if-match",
  "if-none-match",
  "range",
  "x-agent-fs-message",
  "x-agent-fs-message-encoding",
];
const AGENT_FS_BEARER = /^Bearer\s+af_\S+$/i;

/** Response headers copied from agent-fs (plus any `x-agent-fs-*`). */
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
  "location",
  "retry-after",
  // agent-fs serves user files (HTML included) with a sandbox CSP. Dropping
  // these would run that content in the API's origin.
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "x-robots-tag",
  "cross-origin-resource-policy",
]);
const EXPOSED_HEADERS = ["X-Agent-FS-Version", "X-Agent-FS-Content-Hash", "Content-Disposition"];

const UNGATED =
  "agent-fs enforces its own af_ auth; register needs a swarm credential; swarm credentials are never forwarded";
const OK_200 = {
  description: "Upstream agent-fs response, streamed verbatim",
  unstructured: "Body is streamed from agent-fs; shape and content-type vary per upstream route",
};

for (const method of ["get", "post", "put", "delete", "patch"] as const) {
  route({
    method,
    path: "/agentfs/{path}",
    pattern: ["agentfs", null],
    exact: false,
    summary: "Streaming pass-through proxy to agent-fs (enabled by AGENT_FS_PROXY)",
    tags: ["Comb"],
    responses: {
      200: OK_200,
      401: {
        description:
          "Returned by agent-fs when credentials are missing or invalid, or by the swarm when POST /agentfs/auth/register has no swarm credential",
      },
      403: {
        description:
          "POST /agentfs/auth/register with a user token for an email that is not the user's",
      },
      413: { description: "POST /agentfs/auth/register body over 16 KB" },
      429: { description: "Too many registrations from this IP (POST /agentfs/auth/register)" },
      502: { description: "agent-fs is unreachable" },
    },
    auth: { apiKey: false },
    ...(method === "get" ? {} : { rbac: { ungated: UNGATED } }),
  });
}

for (const prefix of ["share", "site"] as const) {
  route({
    method: "get",
    path: `/${prefix}/{path}`,
    pattern: [prefix, null],
    exact: false,
    summary: `Public agent-fs ${prefix} page, served through the API (enabled by AGENT_FS_PROXY)`,
    tags: ["Comb"],
    responses: {
      200: {
        description: `agent-fs /${prefix} response, streamed verbatim`,
        unstructured: "HTML page or raw file streamed from agent-fs; content-type varies",
      },
      404: { description: "Unknown or expired link (from agent-fs), or the proxy is off" },
      502: { description: "agent-fs is unreachable" },
    },
    auth: { apiKey: false },
  });
}

/** agent-fs `POST /auth/register` is public and unlimited upstream: 5 per minute per IP here. */
const registerRateLimiter = createIpRateLimiter({ capacity: 5, refillPerMs: 5 / 60_000 });

export function _resetAgentFsRegisterRateLimitForTests(): void {
  registerRateLimiter.reset();
}

const REGISTER_BODY_MAX_BYTES = 16 * 1024;

/**
 * agent-fs `POST /auth/register` does not check that the caller owns the
 * email, and the swarm invites its users' emails to the shared drive. An
 * account made first for a teammate's email would get that teammate's seat.
 * So a registration through the proxy needs a swarm credential: the operator
 * key may register any email, a user token only the user's own email or an
 * alias. Returns the JSON body to send upstream, or null after it wrote the
 * error response.
 */
async function checkRegister(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const auth = await resolveHttpRequestAuth(req, getApiKey());
  if (!auth || auth.page || (auth.kind !== "operator" && auth.kind !== "user")) {
    jsonError(res, "Creating an agent-fs account here needs a swarm API key or user token", 401);
    return null;
  }
  let body: unknown;
  try {
    body = await parseBody(req, REGISTER_BODY_MAX_BYTES);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) jsonError(res, "Request body too large", 413);
    else jsonError(res, "Invalid JSON body", 400);
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    jsonError(res, "Invalid JSON body", 400);
    return null;
  }
  if (auth.kind === "user") {
    const email = (body as { email?: unknown }).email;
    const own = [auth.user.email, ...auth.user.emailAliases]
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().toLowerCase());
    if (typeof email !== "string" || !own.includes(email.trim().toLowerCase())) {
      jsonError(res, "You can create an agent-fs account only for your own email", 403);
      return null;
    }
  }
  // Re-encoded, so agent-fs reads the same email this check read.
  return JSON.stringify(body);
}

/**
 * The path as an upstream router would match it: percent-decoded, repeated
 * slashes collapsed, trailing slash dropped. `/auth/%72egister` and
 * `//auth/register/` must still hit the register limit.
 */
function routedPath(pathOnly: string): string {
  let decoded = pathOnly;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    // A malformed escape: compare the raw bytes.
  }
  return decoded.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/**
 * A path fetch() or the upstream router would rewrite: dot segments (raw or
 * percent-encoded, also behind an encoded `%2F`) and backslashes, which the
 * URL parser treats as `/`. Rejecting them keeps the register limit and the
 * upstream on the same path: `/./auth/register` and `/auth\register` both
 * reach upstream `/auth/register`.
 */
function isNonCanonical(pathOnly: string): boolean {
  let decoded = pathOnly;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    // A malformed escape: check the raw bytes only.
  }
  for (const p of [pathOnly, decoded]) {
    if (p.includes("\\")) return true;
    if (p.split("/").some((s) => s === "." || s === "..")) return true;
  }
  // `.%2e` and the like, in case the decode above failed on a malformed escape.
  return pathOnly.split("/").some((s) => /^(\.|%2e){1,2}$/i.test(s));
}

export async function handleAgentFsProxy(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  const isApi = url.startsWith(`${API_PREFIX}/`);
  const isPublicPage = !isApi && PUBLIC_PREFIXES.some((p) => url.startsWith(p));
  if (!isApi && !isPublicPage) return false;
  const base = upstreamBase();
  if (!base || !isAgentFsProxyEnabled()) return false;
  const method = req.method ?? "GET";
  const allowed = isApi ? ["GET", "POST", "PUT", "DELETE", "PATCH"] : ["GET"];
  if (!allowed.includes(method)) return false;

  // Keep the path and query bytes as sent, so an encoded `%2F` survives.
  const upstreamPath = isApi ? url.slice(API_PREFIX.length) : url;
  const queryStart = upstreamPath.indexOf("?");
  const pathOnly = queryStart === -1 ? upstreamPath : upstreamPath.slice(0, queryStart);
  if (isNonCanonical(pathOnly)) {
    jsonError(res, "Invalid path", 400);
    return true;
  }
  // Limit on the path fetch() will send, not on our own parse of the raw
  // target: fetch drops a raw `#fragment`, so `/auth/register#x` reaches
  // upstream `/auth/register`.
  const upstreamUrl = `${base}${upstreamPath}`;
  let sentPath: string;
  try {
    // Strip the base URL's own path prefix, if AGENT_FS_API_URL carries one.
    const basePath = new URL(base).pathname.replace(/\/+$/, "");
    sentPath = new URL(upstreamUrl).pathname.slice(basePath.length);
  } catch {
    jsonError(res, "Invalid path", 400);
    return true;
  }
  const isRegister = isApi && method === "POST" && routedPath(sentPath) === "/auth/register";
  if (isRegister && !registerRateLimiter.take(clientIp(req))) {
    res.setHeader("Retry-After", "12");
    jsonError(res, "rate_limited", 429);
    return true;
  }
  const registerBody = isRegister ? await checkRegister(req, res) : null;
  if (isRegister && registerBody === null) return true;

  const headers = new Headers();
  const authorization = req.headers.authorization?.trim();
  // Only an agent-fs key goes upstream: never on register (the swarm credential
  // authorized it), and never the swarm API key, even when it looks like one.
  if (
    registerBody === null &&
    authorization &&
    AGENT_FS_BEARER.test(authorization) &&
    authorization.replace(/^bearer\s+/i, "") !== getApiKey()
  ) {
    headers.set("authorization", authorization);
  }
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const v = req.headers[name];
    if (typeof v === "string") headers.set(name, v);
  }
  if (registerBody !== null) {
    // The body was read and re-encoded: fetch sets the new length.
    headers.delete("content-length");
    headers.set("content-type", "application/json");
  }

  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  const hasBody = method !== "GET" && method !== "DELETE";
  let upstream: Response;
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      redirect: "manual",
      signal: ac.signal,
    };
    if (registerBody !== null) {
      init.body = registerBody;
    } else if (hasBody) {
      // Stream the request body; Bun and undici need duplex "half" for that.
      init.body = Readable.toWeb(req) as RequestInit["body"];
      init.duplex = "half";
    }
    upstream = await fetch(upstreamUrl, init);
  } catch {
    if (!res.headersSent && !res.destroyed) jsonError(res, "agent-fs upstream unavailable", 502);
    else res.destroy();
    return true;
  }

  if (isPublicPage) {
    // agent-fs owns CORS on public pages: drop the swarm's echo before copying its headers.
    for (const name of res.getHeaderNames()) {
      if (name.startsWith("access-control-")) res.removeHeader(name);
    }
  }
  const encoded = upstream.headers.has("content-encoding");
  upstream.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    const keep =
      RESPONSE_HEADER_ALLOWLIST.has(n) ||
      n.startsWith("x-agent-fs-") ||
      (isPublicPage && n.startsWith("access-control-"));
    if (!keep) return;
    // fetch() already decoded the body, so the encoded length no longer applies.
    if (encoded && n === "content-length") return;
    res.setHeader(name, value);
  });
  if (isApi) {
    // Let allowlisted browser origins read the agent-fs response headers (the base
    // list in setCorsHeaders only covers Content-Type, Content-Length, ETag, Location).
    const expose = res.getHeader("Access-Control-Expose-Headers");
    if (typeof expose === "string" && expose !== "*") {
      res.setHeader("Access-Control-Expose-Headers", `${expose}, ${EXPOSED_HEADERS.join(", ")}`);
    }
  }
  res.writeHead(upstream.status);
  if (!upstream.body) {
    res.end();
    return true;
  }
  await pump(upstream.body, res);
  return true;
}

/** Copy the upstream body to `res`, waiting for `drain` so a slow client never buffers the file. */
async function pump(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = body.getReader();
  const closed = new Promise<void>((resolve) => {
    if (res.destroyed) resolve();
    else res.once("close", () => resolve());
  });
  try {
    for (;;) {
      if (res.destroyed) break;
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        break;
      }
      if (!res.write(value)) {
        await Promise.race([new Promise((resolve) => res.once("drain", resolve)), closed]);
      }
    }
  } catch {
    res.destroy();
  } finally {
    reader.cancel().catch(() => {});
  }
  await closed;
}
