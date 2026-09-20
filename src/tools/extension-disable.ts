import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, toolOk } from "@/tools/utils";
import {
  coerceExtensionSummary,
  extensionToolOutputSchema,
  proxyExtensionsApi,
} from "./extension-common";

export const registerExtensionDisableTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "extension-disable",
    {
      title: "Extension Disable",
      description:
        "Unload and disable an installed extension. Requires a lead, operator, or dashboard user.",
      annotations: { openWorldHint: false },
      inputSchema: z
        .object({
          id: z.string().uuid().describe("Installed extension ID from extension-list."),
        })
        .strict(),
      outputSchema: extensionToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyExtensionsApi({
        method: "POST",
        path: `/api/extensions/${args.id}/disable`,
        requestInfo,
        success: (data) =>
          toolOk("Extension disabled.", {
            data: coerceExtensionSummary((data as { extension?: unknown }).extension),
          }),
      }),
  );
};
