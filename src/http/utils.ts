import type { IncomingMessage, ServerResponse } from "node:http";
import { getActiveTaskCount } from "../be/db";

export function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
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
