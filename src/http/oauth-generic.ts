import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { completeGenericOAuthCallback } from "./oauth-callback";
import { route } from "./route-def";
import { jsonError } from "./utils";

/**
 * Legacy per-provider OAuth redirect target. Retained as a thin compatibility
 * wrapper over the unified, state-keyed callback: everything routes through
 * {@link completeGenericOAuthCallback} by `state`, so the `{provider}` path
 * param is now purely cosmetic. New apps use the single static
 * `/api/oauth/callback` instead. The old linear/jira 409 asymmetry is gone —
 * tracker flows resolve through the same handler.
 */
const genericOAuthCallbackRoute = route({
  method: "get",
  path: "/api/oauth/{provider}/callback",
  pattern: ["api", "oauth", null, "callback"],
  operationId: "oauth_generic_callback",
  summary: "Legacy per-provider OAuth redirect target (delegates to the static callback)",
  tags: ["OAuth"],
  auth: { apiKey: false },
  params: z.object({
    provider: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/),
  }),
  query: z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  }),
  responses: {
    200: { description: "OAuth authorization completed" },
    400: { description: "Missing or invalid OAuth callback parameters" },
    404: { description: "OAuth app not configured" },
    502: { description: "Token exchange failed" },
  },
});

export async function handleGenericOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!genericOAuthCallbackRoute.match(req.method, pathSegments)) return false;

  const parsed = await genericOAuthCallbackRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  if (!parsed.query.state) {
    jsonError(res, "Missing code or state parameter", 400);
    return true;
  }

  const { handled } = await completeGenericOAuthCallback(res, parsed.query);
  if (!handled) {
    jsonError(res, "Invalid or expired OAuth state", 400);
  }
  return true;
}
