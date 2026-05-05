import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getOAuthApp, getOAuthTokens } from "@/be/db-queries/oauth";
import { ensureToken } from "@/oauth/ensure-token";
import { createToolRegistrar } from "@/tools/utils";

export const registerTrackerStatusTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "tracker-status",
    {
      title: "Tracker Status",
      description:
        "Show all connected trackers and their OAuth status (token expiry, workspace info). Proactively refreshes near-expiry tokens before reporting, so the returned `tokenExpiresAt` reflects the row that subsequent API calls (and direct DB reads) will see.",
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
      const providers = ["linear", "jira"] as const;
      // Refresh near-expiry tokens before reading so agents that subsequently
      // read oauth_tokens directly (e.g. via the read-only db-query MCP) see a
      // not-yet-expired access token. ensureToken is no-op when no refresh
      // token is stored and swallows refresh failures internally.
      await Promise.all(providers.map((provider) => ensureToken(provider)));
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
