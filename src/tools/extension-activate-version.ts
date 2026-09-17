import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, toolOk } from "@/tools/utils";
import {
  coerceExtensionSummary,
  extensionToolOutputSchema,
  proxyExtensionsApi,
} from "./extension-common";

export const registerExtensionActivateVersionTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "extension-activate-version",
    {
      title: "Extension Activate Version",
      description:
        "Activate a stored extension version, reloading it if enabled. Requires a lead, operator, or dashboard user.",
      annotations: { openWorldHint: false },
      inputSchema: z
        .object({
          id: z.string().uuid().describe("Installed extension ID from extension-list."),
          version: z.number().int().min(1).describe("Stored version number to activate."),
        })
        .strict(),
      outputSchema: extensionToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyExtensionsApi({
        method: "POST",
        path: `/api/extensions/${args.id}/activate-version`,
        body: { version: args.version },
        requestInfo,
        success: (data) =>
          toolOk("Extension activated.", {
            data: coerceExtensionSummary((data as { extension?: unknown }).extension),
          }),
      }),
  );
};
