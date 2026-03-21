import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getTemplateDefinition } from "@/prompts/registry";
import { createToolRegistrar } from "@/tools/utils";
import { interpolate } from "@/workflows/template";

export const registerPreviewPromptTemplateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "preview-prompt-template",
    {
      title: "Preview Prompt Template",
      description:
        "Dry-run render a prompt template with provided variables. Optionally supply a custom body to preview before saving. Returns the interpolated text and any unresolved {{variable}} tokens.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        eventType: z
          .string()
          .describe("Event type to preview (used to look up header and default body)."),
        body: z.string().optional().describe("Custom body to preview instead of the default."),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Variables to interpolate into the template."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        rendered: z.string(),
        unresolved: z.array(z.string()),
      }),
    },
    async ({ eventType, body: customBody, variables }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            rendered: "",
            unresolved: [],
          },
        };
      }

      try {
        const definition = getTemplateDefinition(eventType);
        const templateBody = customBody ?? definition?.defaultBody ?? "";
        const header = definition?.header ?? "";
        const composed = header ? `${header}\n\n${templateBody}` : templateBody;
        const { result: rendered, unresolved } = interpolate(composed, variables ?? {});

        return {
          content: [
            {
              type: "text",
              text: `Preview for "${eventType}":\n\n${rendered}${unresolved.length > 0 ? `\n\nUnresolved variables: ${unresolved.join(", ")}` : ""}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: "Template rendered successfully.",
            rendered,
            unresolved,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to preview template: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to preview template: ${message}`,
            rendered: "",
            unresolved: [],
          },
        };
      }
    },
  );
};
