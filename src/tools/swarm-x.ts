import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  COMPOSIO_HTTP_METHODS,
  composioArgsFromParts,
  executeComposioRequest,
} from "@swarm/integrations";
import { createToolRegistrar } from "@swarm/mcp-tool";
import * as z from "zod";

const primitiveQueryValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const registerSwarmXTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "swarm_x",
    {
      title: "Swarm X",
      description:
        "Execute an Agent Swarm external command route. v1 supports target='composio' and mirrors `agent-swarm x composio <method> <path>` with the Composio API key injected server-side.",
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        target: z
          .literal("composio")
          .default("composio")
          .describe("External route target. Only 'composio' is supported in v1."),
        method: z.enum(COMPOSIO_HTTP_METHODS).describe("HTTP method to route to Composio."),
        path: z
          .string()
          .min(1)
          .describe(
            "Composio API path relative to the configured base URL, e.g. /tool_router/session.",
          ),
        body: z.unknown().optional().describe("Optional JSON request body."),
        query: z
          .record(z.string(), primitiveQueryValueSchema)
          .optional()
          .describe("Optional query parameters appended to the Composio path."),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Optional extra headers. Auth headers are injected by the server."),
        baseUrl: z.string().url().optional().describe("Optional Composio API base URL override."),
        useOrgKey: z
          .boolean()
          .default(false)
          .describe(
            "Use COMPOSIO_ORG_API_KEY/x-org-api-key instead of COMPOSIO_API_KEY/x-api-key.",
          ),
        raw: z
          .boolean()
          .default(false)
          .describe("Return raw text instead of JSON-pretty output text."),
      }),
      outputSchema: z.object({
        target: z.literal("composio"),
        ok: z.boolean(),
        status: z.number(),
        statusText: z.string(),
        method: z.string(),
        url: z.string(),
        response: z.unknown(),
        responseText: z.string(),
        message: z.string(),
      }),
    },
    async (input) => {
      let result: Awaited<ReturnType<typeof executeComposioRequest>>;
      try {
        result = await executeComposioRequest(
          composioArgsFromParts({
            baseUrl: input.baseUrl,
            body: input.body,
            endpoint: input.path,
            headers: input.headers,
            method: input.method,
            query: input.query,
            raw: input.raw,
            useOrgKey: input.useOrgKey,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `swarm_x composio: ${message}` }],
          structuredContent: {
            target: "composio",
            ok: false,
            status: 0,
            statusText: "Invalid request",
            method: input.method,
            url: "",
            response: null,
            responseText: "",
            message,
          },
          isError: true,
        };
      }

      const message =
        result.error || result.formattedBody || `HTTP ${result.status} ${result.statusText}`.trim();
      const structuredContent = {
        target: "composio" as const,
        ok: result.ok,
        status: result.status,
        statusText: result.statusText,
        method: result.method,
        url: result.url,
        response: result.body,
        responseText: result.text,
        message,
      };

      return {
        content: [{ type: "text", text: message }],
        structuredContent,
        isError: !result.ok,
      };
    },
  );
};
