import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, toolOk } from "@/tools/utils";
import { extensionToolOutputSchema, proxyExtensionsApi } from "./extension-common";

export const registerExtensionDeleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "extension-delete",
    {
      title: "Extension Delete",
      description:
        "Uninstall a disabled extension and delete its stored history. Disable it first with extension-disable. Requires a lead, operator, or dashboard user.",
      annotations: { openWorldHint: false, destructiveHint: true },
      inputSchema: z
        .object({
          id: z.string().uuid().describe("Installed extension ID from extension-list."),
        })
        .strict(),
      outputSchema: extensionToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyExtensionsApi({
        method: "DELETE",
        path: `/api/extensions/${args.id}`,
        requestInfo,
        success: () => toolOk("Extension deleted.", { data: { id: args.id, deleted: true } }),
      }),
  );
};
