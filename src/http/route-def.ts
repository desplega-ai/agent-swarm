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
