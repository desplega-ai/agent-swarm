import { scrubSecrets } from "../utils/secret-scrubber";

/**
 * A 127.0.0.1 forwarder in front of a plain-HTTP MCP endpoint.
 *
 * Some ACP targets (fx) accept an MCP server URL only when it is HTTPS or an
 * explicit loopback HTTP endpoint, and reject `http://api:3013/mcp` with
 * `-32602`. The forwarder listens on an ephemeral loopback port and streams
 * every request and response (SSE included) to `upstream`, so the target sees
 * `http://127.0.0.1:<port>/…`. Worker-side HTTP only: no DB access.
 *
 * Header values are never logged; error text goes through `scrubSecrets`.
 */
export interface McpLoopbackProxy {
  /** `http://127.0.0.1:<port>`, no trailing slash. Append the upstream-relative path. */
  readonly url: string;
  stop(): Promise<void>;
}

/** Hop-by-hop headers a proxy must not forward, plus `host` (the upstream's own). */
const DROPPED_REQUEST_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
];

/** Hosts fx treats as explicit loopback (fx 0.0.15: `127.0.0.2` is rejected). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when `url` is plain `http://` to a host that is not an explicit loopback name. */
export function needsLoopbackProxy(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/**
 * Start a forwarder to `upstream` (a base URL; its path is kept as a prefix).
 * A request for `/mcp?x=1` goes to `<upstream>/mcp?x=1`.
 */
export async function startMcpLoopbackProxy(upstream: string): Promise<McpLoopbackProxy> {
  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/+$/, "");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // SSE responses stay open with no traffic between events.
    idleTimeout: 0,
    async fetch(req) {
      const incoming = new URL(req.url);
      const target = new URL(base);
      target.pathname = `${prefix}${incoming.pathname}`;
      target.search = incoming.search;
      const headers = new Headers(req.headers);
      for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
      try {
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        return await fetch(target, {
          method: req.method,
          headers,
          body: hasBody ? req.body : undefined,
          redirect: "manual",
          signal: req.signal,
          // Pass bytes through untouched: decompressing here would leave a
          // stale content-encoding header on the forwarded response.
          decompress: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(
          JSON.stringify({
            error: scrubSecrets(`MCP loopback proxy: upstream failed: ${message}`),
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    },
  });
  let stopped: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      stopped ??= server.stop(true);
      return stopped;
    },
  };
}
