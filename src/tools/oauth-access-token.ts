import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getOAuthTokens } from "@/be/db-queries/oauth";
import { ensureTokenOrThrow } from "@/oauth/ensure-token";
import { createToolRegistrar } from "@/tools/utils";
import { registerVolatileSecret } from "@/utils/secret-scrubber";

type OAuthProvider = string;

export interface OAuthAccessTokenResult {
  provider: OAuthProvider;
  accessToken: string;
  expiresAt: string;
  tokenType: "Bearer";
}

function assertTokenUsable(
  provider: OAuthProvider,
  expiresAt: string,
  minValidityMs: number,
): void {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(`${provider} OAuth token has an invalid expiry`);
  }
  if (expiresAtMs - Date.now() < minValidityMs) {
    throw new Error(
      `${provider} OAuth token is expired or expiring soon and could not be refreshed`,
    );
  }
}

export async function resolveOAuthAccessToken(
  provider: OAuthProvider,
  minValiditySeconds = 300,
): Promise<OAuthAccessTokenResult> {
  const minValidityMs = minValiditySeconds * 1000;
  await ensureTokenOrThrow(provider, minValidityMs);

  const tokens = getOAuthTokens(provider);
  if (!tokens) {
    throw new Error(`${provider} OAuth tokens are not connected`);
  }

  assertTokenUsable(provider, tokens.expiresAt, minValidityMs);
  registerVolatileSecret(tokens.accessToken, `${provider.toUpperCase()}_OAUTH_ACCESS_TOKEN`);

  return {
    provider,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    tokenType: "Bearer",
  };
}

export const registerGetOauthAccessTokenTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-oauth-access-token",
    {
      title: "Get OAuth access token",
      description:
        "Return a valid plaintext OAuth access token for an integrated tracker. The token is refreshed first when it is near expiry. Returns access_token only; never returns refresh_token.",
      annotations: { destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        provider: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "provider must be a slug")
          .describe("OAuth provider slug to read from oauth_tokens (for example: linear, jira)."),
        minValiditySeconds: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .optional()
          .default(300)
          .describe("Minimum remaining token lifetime required before returning it."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        provider: z.string().optional(),
        accessToken: z.string().optional(),
        expiresAt: z.string().optional(),
        tokenType: z.literal("Bearer").optional(),
      }),
    },
    async ({ provider, minValiditySeconds }, _requestInfo, _meta) => {
      try {
        const token = await resolveOAuthAccessToken(provider, minValiditySeconds);
        const message = `${provider} OAuth access token resolved; expires at ${token.expiresAt}.`;
        return {
          content: [
            {
              type: "text",
              text: `${message}\n\n${token.accessToken}`,
            },
          ],
          structuredContent: {
            success: true,
            message,
            ...token,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to resolve OAuth access token: ${message}` }],
          structuredContent: {
            success: false,
            message,
          },
        };
      }
    },
  );
};
