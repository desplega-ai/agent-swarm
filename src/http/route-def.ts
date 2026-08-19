import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { PermissionVerb } from "../rbac";
import { scrubSecrets } from "../utils/secret-scrubber";
import { jsonError, matchRoute, parseBody } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────────────

type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

interface RouteResponseDef {
  description: string;
  schema?: z.ZodType;
  /**
   * Reason this response intentionally carries no JSON schema — SSE stream,
   * binary download, HTML, redirect, proxied upstream body, intentionally
   * dynamic shape, etc. Mutually exclusive with `schema`. Every 2xx response
   * (except bodiless 204/205/304) must declare one of the two — enforced by
   * `bun run check:openapi-response-coverage` (CI).
   */
  unstructured?: string;
}

type ResponsesDef = Record<number, RouteResponseDef>;

/** Extracts the payload type respond() accepts for one response def. */
type ResponseData<R> = R extends { schema: infer S extends z.ZodType } ? z.input<S> : never;

/**
 * Optional `X-Runtime-Instance-ID` header shared by the lifecycle and poll
 * routes. Optional in the schema because the requirement is conditional:
 * only multi-runtime mode needs it, and legacy deployments must keep working
 * without it.
 */
export const runtimeInstanceHeader = (operation: string) =>
  z.object({
    "X-Runtime-Instance-ID": z
      .string()
      .optional()
      .describe(
        "Identifies the concrete runtime instance (worker process) making the call, " +
          `as generated at its boot. Required to ${operation} when multi-runtime mode ` +
          "(MULTI_RUNTIME_ENABLED) is on; ignored otherwise.",
      ),
  });

export interface RouteDef<
  TParams extends z.ZodType = z.ZodType,
  TQuery extends z.ZodType = z.ZodType,
  TBody extends z.ZodType = z.ZodType,
  TResponses extends ResponsesDef = ResponsesDef,
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
  /**
   * Request headers to publish as OpenAPI parameters, beyond the global
   * `Authorization`/`X-Agent-ID` security schemes. Declaration-only: handlers
   * still read headers off `req`, so adding this to a route changes the
   * generated spec and nothing else. Mark each property `.optional()` unless
   * the header is unconditionally required.
   */
  headers?: z.ZodObject;
  body?: TBody;
  responses: TResponses;
  auth?: {
    apiKey?: boolean; // default true
    agentId?: boolean; // requires X-Agent-ID
  };
  /**
   * RBAC posture (DES-445). Required on every non-GET route — enforced by
   * `bun run check:rbac-coverage` (CI). Either name the `PermissionVerb` the
   * handler gates via `can()`, or document why no principal gate applies.
   * Declarative in slice 1: the handler still calls `can()` itself; the role
   * engine (increment 3) may enforce the declared verb centrally.
   */
  rbac?: { permission: PermissionVerb } | { ungated: string };
}

interface ParsedRequest<TParams, TQuery, TBody> {
  params: TParams;
  query: TQuery;
  body: TBody;
}

interface RouteHandle<TParams, TQuery, TBody, TResponses extends ResponsesDef = ResponsesDef> {
  /** Check if this route matches the request */
  match(method: string | undefined, pathSegments: string[]): boolean;

  /** Parse + validate params, query, body. Returns null and sends 400 on validation failure. */
  parse(
    req: IncomingMessage,
    res: ServerResponse,
    pathSegments: string[],
    queryParams: URLSearchParams,
  ): Promise<ParsedRequest<TParams, TQuery, TBody> | null>;

  /**
   * Typed JSON egress: send `data` as the response body for `code`, with `data`
   * compile-time checked against the `schema` declared for that code — the
   * declared OpenAPI shape and the wire shape cannot drift silently. Only
   * callable for codes that declare a `schema`; keep `jsonError` for error
   * paths and raw `res` for bodiless/unstructured responses.
   *
   * Outside production the payload is additionally runtime-validated against
   * the schema (throws → 500 + test failure), catching mismatches the type
   * system can't see through `any`-typed DB rows. Always sends the raw `data`
   * object, never the parsed output — validation must not change the wire.
   */
  respond<C extends keyof TResponses & number>(
    res: ServerResponse,
    code: C,
    data: ResponseData<TResponses[C]>,
  ): void;

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

/**
 * Runtime response validation gate for `respond()`. Only `bun test`
 * (NODE_ENV=test) fails hard on a violation: one bad row must never take an
 * endpoint down outside tests (2026-08-18 incident — a single priority='high'
 * row 500'd every task listing). When the gate is on outside tests
 * (NODE_ENV=development, or VALIDATE_HTTP_RESPONSES=true), `respond()` logs
 * the violation and sends the response anyway. Note: the compiled Bun binary
 * defaults NODE_ENV to "development", so deploys must also set
 * NODE_ENV=production explicitly (see the deploy-env change in the fix PR).
 */
const VALIDATE_RESPONSES =
  process.env.NODE_ENV === "test" ||
  process.env.NODE_ENV === "development" ||
  process.env.VALIDATE_HTTP_RESPONSES === "true";

export function route<
  TParams extends z.ZodType = z.ZodUndefined,
  TQuery extends z.ZodType = z.ZodUndefined,
  TBody extends z.ZodType = z.ZodUndefined,
  TResponses extends ResponsesDef = ResponsesDef,
>(
  def: RouteDef<TParams, TQuery, TBody, TResponses>,
): RouteHandle<z.infer<TParams>, z.infer<TQuery>, z.infer<TBody>, TResponses> {
  routeRegistry.push(def as RouteDef);

  return {
    def: def as RouteDef,

    respond(res, code, data) {
      if (VALIDATE_RESPONSES) {
        const schema = (def.responses as ResponsesDef)[code]?.schema;
        if (schema) {
          const result = schema.safeParse(data);
          if (!result.success) {
            const detail =
              `Response schema violation: ${def.method.toUpperCase()} ${def.path} ${code} — ` +
              result.error.issues
                .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
                .join("; ");
            if (process.env.NODE_ENV === "test") {
              throw new Error(detail);
            }
            console.error(`[route-def] ${scrubSecrets(detail)}`);
          }
        }
      }
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    },

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
