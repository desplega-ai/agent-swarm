import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";
import {
  proxyScriptsApi,
  scriptNameSchema,
  scriptScopeSchema,
  scriptToolOutputSchema,
} from "./script-common";

export const SCRIPT_QUERY_TYPES_DESCRIPTION =
  "Fetch the auto-generated `swarm-sdk.d.ts` (derived from the live MCP tool registry) + the `stdlib.d.ts` blobs — for IDE-style introspection before authoring or running a script. Pass `name` to also get that script's signature; omit it for the swarm-wide type surface. The same types are used by `script-upsert`'s typecheck pass, so they are authoritative.";

function renderTypeBlobs(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const body = data as {
    signature?: unknown;
    argsJsonSchema?: unknown;
    sdkTypes?: unknown;
    stdlibTypes?: unknown;
  };
  const parts: string[] = [];
  if (body.signature !== undefined && body.signature !== null) {
    parts.push(`signature:\n${JSON.stringify(body.signature, null, 2)}`);
  }
  if (body.argsJsonSchema !== undefined && body.argsJsonSchema !== null) {
    parts.push(`argsJsonSchema:\n${JSON.stringify(body.argsJsonSchema, null, 2)}`);
  }
  if (typeof body.sdkTypes === "string" && body.sdkTypes) {
    parts.push(`swarm-sdk.d.ts:\n${body.sdkTypes}`);
  }
  if (typeof body.stdlibTypes === "string" && body.stdlibTypes) {
    parts.push(`stdlib.d.ts:\n${body.stdlibTypes}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export const registerScriptQueryTypesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-query-types",
    {
      title: "Script Query Types",
      description: SCRIPT_QUERY_TYPES_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        name: scriptNameSchema
          .optional()
          .describe(
            "Optional script name whose signature should be fetched. Omit to get the swarm-wide sdk/stdlib type surface.",
          ),
        scope: scriptScopeSchema.optional().describe("Optional scope for script resolution."),
      }),
      outputSchema: scriptToolOutputSchema,
    },
    async ({ name, scope }, requestInfo) => {
      if (!name) {
        return proxyScriptsApi({
          method: "GET",
          path: "/api/scripts/type-defs",
          requestInfo,
          successMessage: () => "Swarm script SDK + stdlib type definitions fetched.",
          successDetails: renderTypeBlobs,
          uncappedDetails: true,
        });
      }
      const query = scope ? `?scope=${encodeURIComponent(scope)}` : "";
      return proxyScriptsApi({
        method: "GET",
        path: `/api/scripts/${encodeURIComponent(name)}/types${query}`,
        requestInfo,
        successMessage: () => `Type definitions for script \`${name}\` fetched.`,
        successDetails: renderTypeBlobs,
        uncappedDetails: true,
      });
    },
  );
};
