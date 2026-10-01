import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar, toolOk } from "@/tools/utils";
import { checkExtensionInstallSource, ExtensionManifestSchema } from "@/types";
import {
  coerceExtensionSummary,
  extensionToolOutputSchema,
  proxyExtensionsApi,
} from "./extension-common";

export const EXTENSION_INSTALL_DESCRIPTION =
  "Install an extension from the catalog by `template` name (extension-catalog, GET /api/extensions/catalog), or from an inline bundle: `manifest` plus a `files` map keyed by bundle path. `template` and `manifest`/`files` are mutually exclusive. Inline bundles are accepted only when the deployment sets EXTENSION_ALLOW_INLINE_INSTALL=true, and only from lead, operator and dashboard-user callers. Workers are denied (403) and stay catalog-only; with the flag off the call fails with inline_install_disabled. Before writing an inline bundle, fetch the hook contract: GET /api/extensions/type-defs returns swarm-extension.d.ts. Install creates the extension, its ext:<name> agent and every asset it declares (scripts, and disabled schedules, workflows and skills). Any authenticated agent may install from the catalog; the installing agent is recorded as createdByAgentId. Workers may install subsequent versions only for their own extensions; those versions remain inactive. A new extension remains disabled until a lead, operator, or dashboard user enables it with extension-enable.";

const extensionInstallInputSchema = z
  .object({
    template: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Name of a predefined extension from extension-catalog. Mutually exclusive with manifest and files.",
      ),
    manifest: ExtensionManifestSchema.optional().describe(
      "Inline bundle manifest. Requires files. Needs EXTENSION_ALLOW_INLINE_INSTALL and a lead, operator, or dashboard-user caller.",
    ),
    files: z
      .record(z.string(), z.string())
      .optional()
      .describe("Inline bundle files keyed by relative path. Requires manifest."),
    priority: z.number().int().optional().describe("Handler priority. Lower values run first."),
    config: z.record(z.string(), z.unknown()).optional().describe("Extension configuration."),
  })
  .strict()
  .superRefine(checkExtensionInstallSource);

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
      inputSchema: extensionInstallInputSchema,
      outputSchema: extensionToolOutputSchema,
    },
    async (args, requestInfo) =>
      proxyExtensionsApi({
        method: "POST",
        path: "/api/extensions/install",
        body: args,
        requestInfo,
        success: (data) =>
          extensionInstallResult(data, args.template ?? args.manifest?.name ?? "extension"),
      }),
  );
};
