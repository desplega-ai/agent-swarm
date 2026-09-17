import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, toolOk } from "@/tools/utils";
import {
  coerceExtensionSummary,
  extensionToolOutputSchema,
  proxyExtensionsApi,
} from "./extension-common";

export const registerExtensionEnableTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "extension-enable",
    {
      title: "Extension Enable",
      description:
        "Load and enable an installed extension. Requires a lead, operator, or dashboard user.",
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
        path: `/api/extensions/${args.id}/enable`,
        requestInfo,
        success: (data) =>
          toolOk("Extension enabled.", {
            data: coerceExtensionSummary((data as { extension?: unknown }).extension),
          }),
      }),
  );
};
