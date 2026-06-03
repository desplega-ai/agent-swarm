import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createMetric, getMetric, getMetricBySlug, getMetricVersions, updateMetric } from "@/be/db";
import { assertSelectOnlyQuery } from "@/http/db-query";
import { snapshotMetric } from "@/metrics/version";
import { createToolRegistrar } from "@/tools/utils";
import { MetricDefinitionSchema } from "@/types";
import { getAppUrl } from "@/utils/constants";

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "metric";
}

function getAppBaseUrl(): string {
  return getAppUrl();
}

function metricEditCounter(metricId: string): number {
  const versions = getMetricVersions(metricId);
  return versions.length > 0 ? versions[0]!.version + 1 : 1;
}

export const registerCreateMetricTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create_metric",
    {
      title: "Create or update a metric",
      description:
        "Stores a config-driven dashboard backed by read-only SQL widget queries. " +
        "Calls are upsert-by-(agent, slug), mirroring create_page: same slug updates " +
        "the existing dashboard and snapshots the prior JSON definition.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        title: z.string().min(1).describe("Human-readable dashboard title."),
        slug: z
          .string()
          .min(1)
          .optional()
          .describe("URL-safe slug. Defaults to the kebab-cased title."),
        description: z.string().optional().describe("Short description shown in the dashboard."),
        definition: MetricDefinitionSchema.describe(
          "Dashboard JSON definition: a list of widgets, each with SELECT/WITH SQL and viz config.",
        ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string(),
        id: z.string(),
        version: z.number(),
        app_url: z.string(),
        success: z.boolean().optional(),
        message: z.string().optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        const msg = "Agent ID required. Set the X-Agent-ID header on the MCP request.";
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: {
            yourAgentId: "",
            id: "",
            version: 0,
            app_url: "",
            success: false,
            message: msg,
          },
          isError: true,
        };
      }

      try {
        for (const widget of input.definition.widgets) {
          assertSelectOnlyQuery(widget.query.sql);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Metric query rejected: ${msg}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            id: "",
            version: 0,
            app_url: "",
            success: false,
            message: msg,
          },
          isError: true,
        };
      }

      const slug = input.slug ?? slugify(input.title);
      const existing = getMetricBySlug(requestInfo.agentId, slug);
      let id: string;

      if (existing) {
        try {
          snapshotMetric(existing.id, requestInfo.agentId);
        } catch {
          // Snapshot failure should not block updates.
        }
        const updated = updateMetric(existing.id, {
          title: input.title,
          description: input.description,
          definition: input.definition,
        });
        if (!updated) {
          const msg = `Failed to update existing metric ${existing.id}.`;
          return {
            content: [{ type: "text", text: msg }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              id: existing.id,
              version: 0,
              app_url: "",
              success: false,
              message: msg,
            },
            isError: true,
          };
        }
        id = updated.id;
      } else {
        try {
          const created = createMetric({
            agentId: requestInfo.agentId,
            slug,
            title: input.title,
            description: input.description,
            definition: input.definition,
          });
          id = created.id;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const msg = `Failed to create metric: ${detail}`;
          return {
            content: [{ type: "text", text: msg }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              id: "",
              version: 0,
              app_url: "",
              success: false,
              message: msg,
            },
            isError: true,
          };
        }
      }

      const fresh = getMetric(id);
      if (!fresh) {
        const msg = `Metric ${id} disappeared between write and read.`;
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            id,
            version: 0,
            app_url: "",
            success: false,
            message: msg,
          },
          isError: true,
        };
      }

      const version = metricEditCounter(id);
      const appUrl = `${getAppBaseUrl()}/usage/metrics`;
      return {
        content: [
          {
            type: "text",
            text: `Metric "${input.title}" saved (slug=${slug}, version=${version}).\n  App: ${appUrl}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          id,
          version,
          app_url: appUrl,
        },
      };
    },
  );
};
