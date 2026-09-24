import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";
import { proxyExtensionsApi } from "./extension-common";

export const EXTENSION_CATALOG_DESCRIPTION =
  "List the predefined extensions that can be installed (the only install source), with their declared assets and installed state. Install one by name with extension-install.";

const catalogItemSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  manifestFile: z.string().optional(),
  assets: z.record(z.string(), z.number()).optional(),
  installed: z
    .looseObject({
      id: z.string().optional(),
      version: z.number().optional(),
      enabled: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

type CatalogItem = z.infer<typeof catalogItemSchema>;

function catalogItems(data: unknown): CatalogItem[] {
  const extensions = (data as { extensions?: unknown } | null)?.extensions;
  if (!Array.isArray(extensions)) return [];
  return extensions.flatMap((entry) => {
    const parsed = catalogItemSchema.safeParse(entry);
    if (!parsed.success) return [];
    const { readme: _readme, ...item } = parsed.data;
    return [item];
  });
}

function renderCatalogTable(items: CatalogItem[]): string {
  const header = "| Name | Version | Assets | Installed | Description |";
  const divider = "| --- | --- | --- | --- | --- |";
  const rows = items.map((item) => {
    const assets =
      Object.entries(item.assets ?? {})
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ") || "hooks only";
    const installed = item.installed
      ? `v${item.installed.version ?? "?"}${item.installed.enabled ? ", enabled" : ", disabled"}`
      : "no";
    return `| ${item.name ?? "?"} | ${item.version ?? "?"} | ${assets} | ${installed} | ${item.description ?? ""} |`;
  });
  return [header, divider, ...rows].join("\n");
}

export const registerExtensionCatalogTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "extension-catalog",
    {
      title: "Extension Catalog",
      description: EXTENSION_CATALOG_DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}).strict(),
      outputSchema: swarmToolOutputSchema({ extensions: z.array(catalogItemSchema).optional() }),
    },
    async (_args, requestInfo) =>
      proxyExtensionsApi({
        method: "GET",
        path: "/api/extensions/catalog",
        requestInfo,
        success: (data) => {
          const extensions = catalogItems(data);
          return toolOk(`Found ${extensions.length} predefined extension(s).`, {
            details: renderCatalogTable(extensions),
            data: { extensions },
          });
        },
      }),
  );
};
