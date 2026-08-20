import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getOAuthApp, getOAuthTokens } from "@/be/db-queries/oauth";
import { ensureToken } from "@/oauth/ensure-token";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";

export const registerTrackerStatusTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "tracker-status",
    {
      title: "Tracker Status",
      description:
        "Show all connected trackers and their OAuth status (token expiry, workspace info). Proactively refreshes near-expiry tokens before reporting, so the returned `tokenExpiresAt` reflects the row that subsequent API calls (and direct DB reads) will see.",
      annotations: { readOnlyHint: true },

      outputSchema: swarmToolOutputSchema({
        trackers: z
          .array(
            z.looseObject({
              provider: z.string().optional(),
              connected: z.boolean().optional(),
              tokenExpiresAt: z.string().nullable().optional(),
              scopes: z.string().nullable().optional(),
              redirectUri: z.string().nullable().optional(),
            }),
          )
          .optional(),
      }),
    },
    async (_requestInfo, _meta) => {
      const providers = ["linear", "jira"] as const;
      // Refresh near-expiry tokens before reading so agents that subsequently
      // read oauth_tokens directly (e.g. via the read-only db-query MCP) see a
      // not-yet-expired access token. ensureToken is no-op when no refresh
      // token is stored and swallows refresh failures internally.
      await Promise.all(providers.map((provider) => ensureToken(provider)));
      const trackers = await Promise.all(
        providers.map(async (provider) => {
          const app = await getOAuthApp(provider);
          const tokens = await getOAuthTokens(provider);

          return {
            provider,
            connected: !!tokens,
            tokenExpiresAt: tokens?.expiresAt ?? null,
            scopes: tokens?.scope ?? app?.scopes ?? null,
            redirectUri: app?.redirectUri ?? null,
          };
        }),
      );

      const summary = trackers
        .map((t) => `${t.provider}: ${t.connected ? "connected" : "not connected"}`)
        .join(", ");

      const details = trackers
        .map((t) => {
          const bits = [
            `provider: ${t.provider}`,
            `connected: ${t.connected}`,
            `tokenExpiresAt: ${t.tokenExpiresAt ?? "n/a"}`,
            `scopes: ${t.scopes ?? "n/a"}`,
            `redirectUri: ${t.redirectUri ?? "n/a"}`,
          ];
          return `- ${bits.join(", ")}`;
        })
        .join("\n");

      return toolOk(`Tracker status: ${summary}`, { details, data: { trackers } });
    },
  );
};
