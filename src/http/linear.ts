/**
 * HTTP handlers for the Linear integration OAuth flow.
 *
 * GET /api/linear/authorize  — Redirect to Linear OAuth consent screen
 * GET /api/linear/callback   — Handle the OAuth callback, exchange code for tokens
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAuthorizationUrl, handleOAuthCallback, isLinearEnabled } from "../linear";
import { route } from "./route-def";

// ─── Route Definitions ──────────────────────────────────────────────────────

const linearAuthorize = route({
  method: "get",
  path: "/api/linear/authorize",
  pattern: ["api", "linear", "authorize"],
  summary: "Redirect to Linear OAuth consent screen",
  tags: ["Linear"],
  auth: { apiKey: false },
  responses: {
    302: { description: "Redirect to Linear OAuth" },
    500: { description: "Failed to generate authorization URL" },
    503: { description: "Linear integration not configured" },
  },
});

const linearCallback = route({
  method: "get",
  path: "/api/linear/callback",
  pattern: ["api", "linear", "callback"],
  summary: "Handle Linear OAuth callback",
  tags: ["Linear"],
  auth: { apiKey: false },
  responses: {
    200: { description: "OAuth authorization complete" },
    400: { description: "Missing or invalid parameters" },
    500: { description: "OAuth callback failed" },
    503: { description: "Linear integration not configured" },
  },
});

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleLinear(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  // ── GET /api/linear/authorize ──
  if (linearAuthorize.match(req.method, pathSegments)) {
    if (!isLinearEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Linear integration not configured" }));
      return true;
    }

    try {
      const url = await getAuthorizationUrl();
      res.writeHead(302, { Location: url });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Linear] Error generating authorization URL: ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to generate authorization URL", details: message }));
    }
    return true;
  }

  // ── GET /api/linear/callback ──
  if (linearCallback.match(req.method, pathSegments)) {
    if (!isLinearEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Linear integration not configured" }));
      return true;
    }

    // Parse query params from the URL
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      console.error(`[Linear] OAuth error: ${error}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `OAuth denied: ${error}` }));
      return true;
    }

    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing code or state parameter" }));
      return true;
    }

    try {
      await handleOAuthCallback(code, state);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Linear Connected!</h1><p>OAuth authorization complete. You can close this window.</p></body></html>",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Linear] OAuth callback error: ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "OAuth callback failed", details: message }));
    }
    return true;
  }

  return false;
}
