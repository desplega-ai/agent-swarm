import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, toolOk } from "@/tools/utils";
import {
  coerceExtensionSummary,
  extensionToolOutputSchema,
  proxyExtensionsApi,
} from "./extension-common";

export const EXTENSION_LIST_DESCRIPTION = "List installed extensions and their activation state.";

type ExtensionListItem = ReturnType<typeof coerceExtensionSummary>;

function extensionListItems(data: unknown): ExtensionListItem[] {
  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as { extensions?: unknown }).extensions)
  ) {
    return [];
  }
  return (data as { extensions: unknown[] }).extensions.map(coerceExtensionSummary);
}

function renderExtensionsTable(extensions: ExtensionListItem[]): string {
  const header = "| Name | Version | Active | Enabled | Status | Priority | Failures |";
  const divider = "| --- | ---: | ---: | --- | --- | ---: | ---: |";
  const rows = extensions.map(
    (extension) =>
      `| ${extension.name ?? "?"} | ${extension.version ?? "?"} | ${extension.activeVersion ?? "?"} | ${extension.enabled ?? false} | ${extension.status ?? "unknown"} | ${extension.priority ?? "?"} | ${extension.consecutiveFailures ?? 0} |`,
  );
  return [header, divider, ...rows].join("\n");
}

export const registerExtensionListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "extension-list",
    {
      title: "Extension List",
      description: EXTENSION_LIST_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z
        .object({
          enabledOnly: z.boolean().optional().describe("Return only enabled extensions."),
        })
        .strict(),
      outputSchema: extensionToolOutputSchema,
    },
    async ({ enabledOnly }, requestInfo) =>
      proxyExtensionsApi({
        method: "GET",
        path: "/api/extensions",
        requestInfo,
        success: (data) => {
          const extensions = extensionListItems(data).filter(
            (extension) => !enabledOnly || extension.enabled,
          );
          return toolOk(`Found ${extensions.length} extension(s).`, {
            details: renderExtensionsTable(extensions),
            data: { extensions },
          });
        },
      }),
  );
};
