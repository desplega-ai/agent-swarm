// @ts-nocheck: spike code, not typechecked by the repo (imports resolve in the spike worktree only).
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { route } from "./route-def";
import { jsonError } from "./utils";

/**
 * `/agentfs/*` streaming pass-through to the agent-fs server at AGENT_FS_API_URL.
 *
 * The swarm does no auth here: agent-fs enforces its own `af_` bearer. Only an
 * allowlist of request headers is forwarded (never Cookie or X-Agent-ID), the
 * upstream CORS headers are dropped (the swarm's own setCorsHeaders already ran),
 * and both bodies are streamed. Inactive unless AGENT_FS_PROXY=true.
 */

const PREFIX = "/agentfs";

function upstreamBase(): string | null {
  const v = process.env.AGENT_FS_API_URL?.trim().replace(/\/+$/, "");
  return v || null;
}
const REQUEST_HEADER_ALLOWLIST = [
  "authorization",
  "content-type",
  "content-length",
  "accept",
  "if-match",
  "if-none-match",
  "range",
  "x-agent-fs-message",
  "x-agent-fs-message-encoding",
];
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "set-cookie",
]);
const EXPOSED_HEADERS = ["X-Agent-FS-Version", "X-Agent-FS-Content-Hash", "Content-Disposition"];

const UNGATED = "agent-fs enforces its own af_ auth; swarm credentials are never forwarded";
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
      401: { description: "Returned by agent-fs when credentials are missing or invalid" },
      502: { description: "agent-fs is unreachable" },
    },
    auth: { apiKey: false },
    ...(method === "get" ? {} : { rbac: { ungated: UNGATED } }),
  });
}

export function isAgentFsProxyEnabled(): boolean {
  return process.env.AGENT_FS_PROXY === "true" && upstreamBase() !== null;
}

export async function handleAgentFsProxy(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith(`${PREFIX}/`) || !isAgentFsProxyEnabled()) return false;
  const method = req.method ?? "GET";
  if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)) return false;

  const upstreamPath = url.slice(PREFIX.length);
  const queryStart = upstreamPath.indexOf("?");
  const pathOnly = queryStart === -1 ? upstreamPath : upstreamPath.slice(0, queryStart);
  if (pathOnly.split("/").some((s) => s === ".." || s.toLowerCase() === "%2e%2e")) {
    jsonError(res, "Invalid path", 400);
    return true;
  }
  const target = `${upstreamBase()}${upstreamPath}`;

  const headers = new Headers();
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const v = req.headers[name];
    if (typeof v === "string") headers.set(name, v);
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
    if (hasBody) {
      // Stream the request body; Bun and undici need duplex "half" for that.
      init.body = Readable.toWeb(req) as RequestInit["body"];
      init.duplex = "half";
    }
    upstream = await fetch(target, init);
  } catch {
    if (!res.headersSent) jsonError(res, "agent-fs upstream unavailable", 502);
    else res.destroy();
    return true;
  }

  const encoded = upstream.headers.has("content-encoding");
  upstream.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (n.startsWith("access-control-") || DROP_RESPONSE_HEADERS.has(n)) return;
    // fetch() already decoded the body, so the encoded length no longer applies.
    if (encoded && (n === "content-encoding" || n === "content-length")) return;
    res.setHeader(name, value);
  });
  // Let allowlisted browser origins read the agent-fs response headers (the base
  // list in setCorsHeaders only covers Content-Type, Content-Length, ETag, Location).
  const expose = res.getHeader("Access-Control-Expose-Headers");
  if (typeof expose === "string" && expose !== "*") {
    res.setHeader("Access-Control-Expose-Headers", `${expose}, ${EXPOSED_HEADERS.join(", ")}`);
  }
  res.writeHead(upstream.status);
  if (!upstream.body) {
    res.end();
    return true;
  }
  const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("error", () => res.destroy());
  body.pipe(res);
  await new Promise<void>((resolve) => res.once("close", () => resolve()));
  return true;
}
