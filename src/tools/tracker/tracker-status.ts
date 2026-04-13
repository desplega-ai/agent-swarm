import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getOAuthApp, getOAuthTokens } from "@/be/db-queries/oauth";
import { createToolRegistrar } from "@/tools/utils";

export const registerTrackerStatusTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "tracker-status",
    {
      title: "Tracker Status",
      description:
        "Show all connected trackers and their OAuth status (token expiry, workspace info).",
      annotations: { readOnlyHint: true },

      outputSchema: z.object({
        success: z.boolean(),
        trackers: z.array(
          z.object({
            provider: z.string(),
            connected: z.boolean(),
            tokenExpiresAt: z.string().nullable(),
            scopes: z.string().nullable(),
            redirectUri: z.string().nullable(),
          }),
        ),
      }),
    },
    async (_requestInfo, _meta) => {
      const providers = ["linear"] as const;
      const trackers = providers.map((provider) => {
        const app = getOAuthApp(provider);
        const tokens = getOAuthTokens(provider);

        return {
          provider,
          connected: !!tokens,
          tokenExpiresAt: tokens?.expiresAt ?? null,
          scopes: tokens?.scope ?? app?.scopes ?? null,
          redirectUri: app?.redirectUri ?? null,
        };
      });

      const summary = trackers
        .map((t) => `${t.provider}: ${t.connected ? "connected" : "not connected"}`)
        .join(", ");

      return {
        content: [{ type: "text", text: `Tracker status: ${summary}` }],
        structuredContent: {
          success: true,
          trackers,
        },
      };
    },
  );
};
