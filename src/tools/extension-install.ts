import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, toolOk } from "@/tools/utils";
import { ExtensionManifestSchema } from "@/types";
import {
  coerceExtensionSummary,
  extensionToolOutputSchema,
  proxyExtensionsApi,
} from "./extension-common";

export const EXTENSION_INSTALL_DESCRIPTION =
  "Any authenticated agent may create and install its own TypeScript extension bundle (manifest plus a files map with one hooks.ts). Fetch the hook contract first: GET /api/extensions/type-defs returns swarm-extension.d.ts with every event and modify shape. The installing agent is recorded as createdByAgentId. Workers may install subsequent versions only for their own extensions; those versions remain inactive. A new extension remains disabled until a lead, operator, or dashboard user enables it with extension-enable.";

function extensionInstallResult(data: unknown, fallbackName: string) {
  const body = data as {
    extension?: unknown;
    contentDeduped?: unknown;
  };
  const extension = coerceExtensionSummary(body.extension);
  const name = extension.name ?? fallbackName;
  const version = typeof extension.version === "number" ? ` v${extension.version}` : "";
  const deduped = body.contentDeduped === true ? " Content was unchanged." : "";
  const enableInstruction =
    "A lead, operator, or dashboard user can enable it with `extension-enable` or `POST /api/extensions/{id}/enable`.";

  return toolOk(`Extension \`${name}\`${version} installed.${deduped} ${enableInstruction}`, {
    data: {
      ...extension,
      name,
      contentDeduped: body.contentDeduped === true,
    },
  });
}

export const registerExtensionInstallTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "extension-install",
    {
      title: "Extension Install",
      description: EXTENSION_INSTALL_DESCRIPTION,
      annotations: { openWorldHint: false },
      inputSchema: z
        .object({
          manifest: ExtensionManifestSchema.describe("Extension bundle manifest."),
          files: z.record(z.string(), z.string()).describe("Bundle files keyed by relative path."),
          priority: z
            .number()
            .int()
            .optional()
            .describe("Handler priority. Lower values run first."),
          config: z.record(z.string(), z.unknown()).optional().describe("Extension configuration."),
        })
        .strict(),
      outputSchema: extensionToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyExtensionsApi({
        method: "POST",
        path: "/api/extensions/install",
        body: args,
        requestInfo,
        success: (data) => extensionInstallResult(data, args.manifest.name),
      }),
  );
};
