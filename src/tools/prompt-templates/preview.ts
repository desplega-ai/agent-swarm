import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getTemplateDefinition } from "@/prompts/registry";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { interpolate } from "@/utils/template";

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        rendered: z.string().optional(),
        unresolved: z.array(z.string()).optional(),
      }),
    },
    async ({ eventType, body: customBody, variables }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.', {
          data: { rendered: "", unresolved: [] },
        });
      }

      try {
        const definition = getTemplateDefinition(eventType);
        const templateBody = customBody ?? definition?.defaultBody ?? "";
        const header = definition?.header ?? "";
        const composed = header ? `${header}\n\n${templateBody}` : templateBody;
        const { result: rendered, unresolved } = interpolate(composed, variables ?? {});

        return toolOk("Template rendered successfully.", {
          details: `Preview for "${eventType}":\n\n${rendered}${unresolved.length > 0 ? `\n\nUnresolved variables: ${unresolved.join(", ")}` : ""}`,
          data: { yourAgentId: requestInfo.agentId, rendered, unresolved },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to preview template: ${message}`, {
          data: { yourAgentId: requestInfo.agentId, rendered: "", unresolved: [] },
        });
      }
    },
  );
};
