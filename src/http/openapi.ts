import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { routeRegistry } from "./route-def";

extendZodWithOpenApi(z);

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
      responses[code] = {
        description: resDef.description,
        ...(resDef.schema && {
          content: {
            "application/json": { schema: resDef.schema },
          },
        }),
      };
    }

    const request: Record<string, unknown> = {};
    if (routeDef.params) request.params = routeDef.params;
    if (routeDef.query) request.query = routeDef.query;
    if (routeDef.body) {
      request.body = {
        content: { "application/json": { schema: routeDef.body } },
      };
    }

    registry.registerPath({
      method: routeDef.method,
      path: routeDef.path,
      summary: routeDef.summary,
      description: routeDef.description,
      tags: routeDef.tags,
      request,
      responses,
      security: routeDef.auth?.apiKey !== false ? [{ bearerAuth: [] }] : undefined,
    });
  }

  const serverUrl =
    opts.serverUrl || process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || "3013"}`;

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
