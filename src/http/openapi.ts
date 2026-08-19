import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { getPublicMcpBaseUrl } from "../utils/constants";
import { z } from "../utils/zod-openapi";
import { routeRegistry } from "./route-def";

/**
 * Default component for 4xx/5xx responses that declare no schema of their own:
 * the `jsonError()` envelope every error path emits. Loose because a few
 * handlers attach extra diagnostic fields (e.g. TriggerSchemaError's
 * `message`/`details`) — those may declare an explicit schema instead.
 */
const ErrorResponseSchema = z
  .looseObject({ error: z.string() })
  .openapi("ErrorResponse", { description: "Standard error envelope" });

let cachedSpec: string | null = null;

interface OpenApiOptions {
  version: string;
  serverUrl?: string;
}

export function generateOpenApiSpec(opts: OpenApiOptions): string {
  if (cachedSpec) return cachedSpec;

  const registry = new OpenAPIRegistry();

  // Register Bearer auth
  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API key via Authorization: Bearer <API_KEY>",
  });

  // Register X-Agent-ID header
  registry.registerComponent("securitySchemes", "agentId", {
    type: "apiKey",
    in: "header",
    name: "X-Agent-ID",
    description: "Agent UUID for agent-scoped operations",
  });

  // Convert route definitions to OpenAPI paths
  for (const routeDef of routeRegistry) {
    const responses: Record<
      string,
      { description: string; content?: Record<string, { schema: z.ZodType }> }
    > = {};
    for (const [code, resDef] of Object.entries(routeDef.responses)) {
      const schema =
        resDef.schema ??
        // Untyped error responses default to the shared jsonError envelope;
        // `unstructured` (non-JSON body) opts out.
        (Number(code) >= 400 && !resDef.unstructured ? ErrorResponseSchema : undefined);
      responses[code] = {
        description: resDef.description,
        ...(schema && {
          content: {
            "application/json": { schema },
          },
        }),
      };
    }

    const request: Record<string, unknown> = {};
    if (routeDef.params) request.params = routeDef.params;
    if (routeDef.query) request.query = routeDef.query;
    if (routeDef.headers) request.headers = routeDef.headers;
    if (routeDef.body) {
      request.body = {
        content: { "application/json": { schema: routeDef.body } },
      };
    }

    registry.registerPath({
      method: routeDef.method,
      path: routeDef.path,
      operationId: routeDef.operationId,
      summary: routeDef.summary,
      description: routeDef.description,
      tags: routeDef.tags,
      request,
      responses,
      security: routeDef.auth?.apiKey !== false ? [{ bearerAuth: [] }] : undefined,
    });
  }

  const serverUrl = opts.serverUrl || getPublicMcpBaseUrl();

  /**
   * zod-to-openapi emits `.nullable()` on an `.extend()`ed (or `$ref`ed)
   * schema as `allOf: [{$ref}, {type: ["object","null"], ...delta}]` — an
   * allOf member allowing null is semantically wrong (the intersection with
   * the non-null base can never be null), and TS-definition generators
   * (fumadocs-openapi) collapse it to `never`. Rewrite to the intended
   * `anyOf: [<intersection>, {type: "null"}]`.
   */
  function fixNullableAllOf(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) fixNullableAllOf(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const allOf = obj.allOf;
    if (Array.isArray(allOf)) {
      let hadNull = false;
      for (const member of allOf) {
        if (member && Array.isArray(member.type) && member.type.includes("null")) {
          hadNull = true;
          const rest = member.type.filter((t: string) => t !== "null");
          member.type = rest.length === 1 ? rest[0] : rest;
        }
      }
      if (hadNull) {
        // Drop members reduced to a bare `{type: "object"}` (no constraints left).
        const members = allOf.filter((m) => !(Object.keys(m).length === 1 && m.type === "object"));
        const intersection = members.length === 1 ? members[0] : { allOf: members };
        delete obj.allOf;
        obj.anyOf = [intersection, { type: "null" }];
      }
    }
    for (const value of Object.values(obj)) fixNullableAllOf(value);
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const doc = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Agent Swarm API",
      version: opts.version,
      description:
        "Multi-agent orchestration API for Claude Code, Codex, and Gemini CLI. " +
        "Enables task distribution, agent communication, and service discovery.\n\n" +
        "MCP tools are documented separately in [MCP.md](./MCP.md).",
    },
    servers: [
      {
        url: serverUrl,
        description: serverUrl.includes("localhost") ? "Local development" : "Production",
      },
    ],
  });

  fixNullableAllOf(doc.paths);
  fixNullableAllOf(doc.components);

  cachedSpec = JSON.stringify(doc, null, 2);
  return cachedSpec;
}

export const SCALAR_HTML = `<!DOCTYPE html>
<html>
<head><title>Agent Swarm API</title><meta charset="utf-8" /></head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
