import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { upsertModelCatalogOverlay } from "@/be/model-catalog-store";
import { refreshModelCatalog } from "@/be/pricing-refresh";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

async function denyUnlessCatalogWriter(agentId: string): Promise<string | null> {
  const agent = await getAgentById(agentId);
  const decision = can({
    principal: { kind: "agent", agentId, isLead: agent?.isLead ?? false },
    verb: "models.catalog.write",
    resource: { kind: "none" },
    source: "mcp",
  });
  return decision.allow ? null : "Writing the model catalog requires the lead agent.";
}

export const registerModelCatalogRefreshTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "model-catalog-refresh",
    {
      title: "Refresh Model Catalog",
      description:
        "Refresh the swarm model catalog (and pricing rows) from models.dev, like `pi update --models`. Without force, skips the network when the last check is under 4h old. Returns the status, model count, and newly added provider/modelId keys.",
      annotations: { idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        force: z
          .boolean()
          .optional()
          .describe("Fetch even if the last check is under 4h old (default false)."),
      }),
      outputSchema: swarmToolOutputSchema({
        status: z.string().optional(),
        models: z.number().optional(),
        added: z.array(z.string()).optional(),
        checkedAt: z.number().nullable().optional(),
      }),
    },
    async ({ force }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const denied = await denyUnlessCatalogWriter(requestInfo.agentId);
      if (denied) return toolErr(denied);

      const result = await refreshModelCatalog({ force });
      const data = {
        status: result.status,
        models: result.models,
        added: result.added,
        checkedAt: result.checkedAt,
      };
      if (result.status === "error") {
        return toolErr(`Model catalog refresh failed: ${result.error ?? "unknown error"}`, {
          data,
        });
      }
      const addedText = result.added.length > 0 ? ` Added: ${result.added.join(", ")}.` : "";
      return toolOk(
        `Model catalog ${result.status}: ${result.models} model(s), ${result.added.length} new.`,
        {
          details: `status=${result.status}; models=${result.models}; added=${result.added.length}.${addedText}`,
          data,
        },
      );
    },
  );
};

export const registerModelCatalogOverlayUpsertTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "model-catalog-overlay-upsert",
    {
      title: "Upsert Model Catalog Overlay",
      description:
        "Add or update hand-verified facts for one model (e.g. a launch models.dev has not listed yet). Overlay fields win over models.dev; overlay prices fill pricing-table gaps so cost recompute prices the model. The row auto-expires once models.dev matches every fact you set.",
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        provider: z
          .string()
          .min(1)
          .describe(
            "models.dev provider id: anthropic, openai, openrouter, amazon-bedrock, opencode.",
          ),
        modelId: z
          .string()
          .min(1)
          .describe("Model id as models.dev keys it (e.g. claude-opus-5-5)."),
        name: z.string().optional().describe("Display name."),
        releaseDate: z.string().optional().describe("Release date, YYYY-MM-DD."),
        contextWindow: z.number().int().positive().optional().describe("Context window, tokens."),
        maxOutput: z.number().int().positive().optional().describe("Max output tokens."),
        reasoningOptions: z
          .array(z.object({ type: z.string(), values: z.array(z.string()).optional() }))
          .optional()
          .describe("Reasoning options, models.dev shape: [{type, values?}]."),
        pricing: z
          .object({
            input: z.number().nonnegative().optional(),
            output: z.number().nonnegative().optional(),
            cache_read: z.number().nonnegative().optional(),
            cache_write: z.number().nonnegative().optional(),
          })
          .optional()
          .describe("USD per million tokens."),
        reason: z.string().min(1).describe("Why this overlay exists (source of the facts)."),
        verifiedBy: z.string().optional().describe("Who verified the facts (URL, person, agent)."),
      }),
      outputSchema: swarmToolOutputSchema({
        overlay: z.looseObject({}).optional(),
      }),
    },
    async (input, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const denied = await denyUnlessCatalogWriter(requestInfo.agentId);
      if (denied) return toolErr(denied);
      try {
        const overlay = await upsertModelCatalogOverlay(input);
        return toolOk(`Overlay for ${input.provider}/${input.modelId} saved.`, {
          details: `Overlay for ${input.provider}/${input.modelId} saved (reason: ${input.reason}). It expires when models.dev matches every fact set.`,
          data: { overlay },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to save overlay: ${message}`);
      }
    },
  );
};
