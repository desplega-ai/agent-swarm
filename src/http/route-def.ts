import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { jsonError, matchRoute, parseBody } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────────────

type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

interface RouteResponseDef {
  description: string;
  schema?: z.ZodType;
}

export interface RouteDef<
  TParams extends z.ZodType = z.ZodType,
  TQuery extends z.ZodType = z.ZodType,
  TBody extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  path: string; // OpenAPI-style: "/api/tasks/{id}"
  pattern: readonly (string | null)[]; // matchRoute-style: ["api", "tasks", null]
  exact?: boolean; // default true
  operationId?: string;
  summary: string;
  description?: string;
  tags: string[];
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  responses: Record<number, RouteResponseDef>;
  auth?: {
    apiKey?: boolean; // default true
    agentId?: boolean; // requires X-Agent-ID
  };
}

interface ParsedRequest<TParams, TQuery, TBody> {
  params: TParams;
  query: TQuery;
  body: TBody;
}

interface RouteHandle<TParams, TQuery, TBody> {
  /** Check if this route matches the request */
  match(method: string | undefined, pathSegments: string[]): boolean;

  /** Parse + validate params, query, body. Returns null and sends 400 on validation failure. */
  parse(
    req: IncomingMessage,
    res: ServerResponse,
    pathSegments: string[],
    queryParams: URLSearchParams,
  ): Promise<ParsedRequest<TParams, TQuery, TBody> | null>;

  /** The raw definition (for OpenAPI generation) */
  def: RouteDef;
}

// ─── Registry ────────────────────────────────────────────────────────────────

/** Global registry — populated at import time, read by OpenAPI generator */
export const routeRegistry: RouteDef[] = [];

/**
 * Check whether a request targets a route declared (via the `route()` factory)
 * with `auth: { apiKey: false }` — i.e. one that opts out of the API-key
 * bearer check. Handler files must use the `route()` factory for this to take
 * effect; unknown paths fail closed (auth required).
 */
export function isPublicRoute(method: string | undefined, pathSegments: string[]): boolean {
  for (const def of routeRegistry) {
    if (def.auth?.apiKey === false) {
      if (
        matchRoute(method, pathSegments, def.method.toUpperCase(), def.pattern, def.exact ?? true)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Look up the registered route definition matching this request, or `undefined`
 * if no `route()`-defined handler matches. First match wins (registry order).
 *
 * Used by the API HTTP span name to map a request to a bounded-cardinality
 * route template (e.g. `/api/tasks/{id}` instead of `/api/tasks/<uuid>`) so
 * SigNoz can group traces by endpoint. Core routes (/health, /ping, /me, etc.)
 * and the MCP transport don't go through the `route()` factory and will return
 * `undefined` here — callers should fall back to a low-cardinality default.
 */
export function findRoute(
  method: string | undefined,
  pathSegments: string[],
): RouteDef | undefined {
  for (const def of routeRegistry) {
    if (
      matchRoute(method, pathSegments, def.method.toUpperCase(), def.pattern, def.exact ?? true)
    ) {
      return def;
    }
  }
  return undefined;
}

/** OTel descriptors derived from a matched (or unmatched) inbound request. */
export interface RequestRouteDescriptor {
  /**
   * Low-cardinality OTel span name following the HTTP semantic conventions:
   * `{METHOD} {route-template}`.
   *
   * - Matched `route()` handler: `GET /api/tasks/{id}`
   * - Unmatched (core /health /ping /me, MCP transport, 404s): `GET /<first-segment>`
   * - Root or empty path: bare `GET`
   */
  spanName: string;
  /**
   * Value for the `http.route` span attribute — the bounded-cardinality route
   * template (e.g. `/api/tasks/{id}`). Set ONLY when a `route()` handler
   * matched; left `undefined` for core/MCP/404 paths so callers omit the
   * attribute rather than fabricating a value.
   */
  httpRoute?: string;
}

/**
 * Describe an inbound HTTP request for OTel: a low-cardinality span name plus
 * the `http.route` attribute value (per the HTTP server semantic conventions).
 *
 * Never embeds raw path params or query strings — the goal is one span name and
 * one `http.route` value per endpoint so SigNoz can group/filter/aggregate by
 * them. The raw path is still preserved on the `url.path` attribute.
 */
export function describeRequestRoute(
  method: string | undefined,
  pathSegments: string[],
): RequestRouteDescriptor {
  const m = (method ?? "").toUpperCase() || "UNKNOWN";
  const matched = findRoute(method, pathSegments);
  if (matched) return { spanName: `${m} ${matched.path}`, httpRoute: matched.path };
  const first = pathSegments[0];
  return { spanName: first ? `${m} /${first}` : m };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function route<
  TParams extends z.ZodType = z.ZodUndefined,
  TQuery extends z.ZodType = z.ZodUndefined,
  TBody extends z.ZodType = z.ZodUndefined,
>(
  def: RouteDef<TParams, TQuery, TBody>,
): RouteHandle<z.infer<TParams>, z.infer<TQuery>, z.infer<TBody>> {
  routeRegistry.push(def as RouteDef);

  return {
    def: def as RouteDef,

    match(method, pathSegments) {
      return matchRoute(
        method,
        pathSegments,
        def.method.toUpperCase(),
        def.pattern,
        def.exact ?? true,
      );
    },

    async parse(req, res, pathSegments, queryParams) {
      try {
        // Extract path params from dynamic segments
        const rawParams: Record<string, string> = {};
        if (def.params) {
          const paramNames = def.path.match(/\{(\w+)\}/g)?.map((p) => p.slice(1, -1)) ?? [];
          for (let i = 0; i < def.pattern.length; i++) {
            if (def.pattern[i] === null && paramNames.length > 0) {
              rawParams[paramNames.shift()!] = pathSegments[i] ?? "";
            }
          }
        }

        // Parse + validate each part
        const params = def.params ? def.params.parse(rawParams) : undefined;
        const query = def.query ? def.query.parse(Object.fromEntries(queryParams)) : undefined;
        const body = def.body ? def.body.parse(await parseBody(req)) : undefined;

        return { params, query, body } as ParsedRequest<
          z.infer<TParams>,
          z.infer<TQuery>,
          z.infer<TBody>
        >;
      } catch (err) {
        if (err instanceof z.ZodError) {
          jsonError(
            res,
            `Validation error: ${err.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
            400,
          );
          return null;
        }
        throw err;
      }
    },
  };
}
