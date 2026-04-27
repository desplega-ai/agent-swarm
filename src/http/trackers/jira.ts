import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getOAuthTokens } from "../../be/db-queries/oauth";
import { isJiraEnabled } from "../../jira/app";
import { getJiraMetadata } from "../../jira/metadata";
import { getJiraAuthorizationUrl, handleJiraCallback } from "../../jira/oauth";
import { handleJiraWebhook } from "../../jira/webhook";
import { route } from "../route-def";
import { parseQueryParams } from "../utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const jiraAuthorize = route({
  method: "get",
  path: "/api/trackers/jira/authorize",
  pattern: ["api", "trackers", "jira", "authorize"],
  summary: "Redirect to Atlassian OAuth consent screen",
  tags: ["Trackers"],
  auth: { apiKey: false },
  responses: {
    302: { description: "Redirect to Atlassian OAuth" },
    500: { description: "Failed to generate authorization URL" },
    503: { description: "Jira integration not configured" },
  },
});

const jiraCallback = route({
  method: "get",
  path: "/api/trackers/jira/callback",
  pattern: ["api", "trackers", "jira", "callback"],
  summary: "Handle Jira OAuth callback (resolves cloudId via accessible-resources)",
  tags: ["Trackers"],
  auth: { apiKey: false },
  query: z.object({
    code: z.string(),
    state: z.string(),
  }),
  responses: {
    200: { description: "OAuth complete" },
    400: { description: "Invalid state or code" },
    500: { description: "Token exchange or accessible-resources fetch failed" },
  },
});

const jiraStatus = route({
  method: "get",
  path: "/api/trackers/jira/status",
  pattern: ["api", "trackers", "jira", "status"],
  summary:
    "Jira connection status, cloudId/siteUrl, token expiry, expected webhook URL, scope/token-config flags",
  tags: ["Trackers"],
  responses: {
    200: { description: "Connection status" },
    503: { description: "Jira integration not configured" },
  },
});

const jiraWebhook = route({
  method: "post",
  path: "/api/trackers/jira/webhook/{token}",
  pattern: ["api", "trackers", "jira", "webhook", null],
  summary:
    "Receive Jira webhook events (URL-token authenticated). Phase 2 stub — Phase 3 fills in dispatch.",
  tags: ["Trackers"],
  auth: { apiKey: false },
  params: z.object({ token: z.string() }),
  responses: {
    200: { description: "Event accepted" },
    401: { description: "Invalid URL token" },
    503: { description: "Jira webhook handler not configured" },
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWebhookBaseUrl(): string {
  return process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || "3013"}`;
}

function getWebhookUrl(): string {
  const token = process.env.JIRA_WEBHOOK_TOKEN ?? "<unset>";
  return `${getWebhookBaseUrl()}/api/trackers/jira/webhook/${token}`;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleJiraTracker(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  // GET /api/trackers/jira/authorize — redirect to Atlassian OAuth consent
  if (jiraAuthorize.match(req.method, pathSegments)) {
    if (!isJiraEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Jira integration not configured" }));
      return true;
    }

    try {
      const url = await getJiraAuthorizationUrl();
      if (!url) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate authorization URL" }));
        return true;
      }

      res.writeHead(302, { Location: url });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Jira] Failed to generate authorization URL:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to generate authorization URL" }));
    }
    return true;
  }

  // GET /api/trackers/jira/callback — handle OAuth callback from Atlassian
  if (jiraCallback.match(req.method, pathSegments)) {
    const queryParams = parseQueryParams(req.url || "");
    const parsed = await jiraCallback.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true; // parse() already sent 400

    const { code, state } = parsed.query;

    try {
      await handleJiraCallback(code, state);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Jira Connected</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <h1>Jira Connected</h1>
    <p>OAuth authorization complete. You can close this window.</p>
  </div>
</body>
</html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Jira] OAuth callback failed:", message);

      if (message.includes("Invalid or expired OAuth state")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or expired OAuth state" }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "OAuth callback failed", details: message }));
      }
    }
    return true;
  }

  // GET /api/trackers/jira/status — connection status (works even when not connected)
  if (jiraStatus.match(req.method, pathSegments)) {
    if (!isJiraEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Jira integration not configured" }));
      return true;
    }

    const tokens = getOAuthTokens("jira");
    const meta = getJiraMetadata();
    const scope = tokens?.scope ?? null;
    // Atlassian returns scopes space-separated in the token response.
    const scopeList = scope ? scope.split(/[\s,]+/).filter(Boolean) : [];

    const status = {
      provider: "jira",
      connected: !!tokens,
      cloudId: meta.cloudId ?? null,
      siteUrl: meta.siteUrl ?? null,
      tokenExpiresAt: tokens?.expiresAt ?? null,
      scope,
      hasManageWebhookScope: scopeList.includes("manage:jira-webhook"),
      webhookTokenConfigured: Boolean(process.env.JIRA_WEBHOOK_TOKEN),
      webhookUrl: getWebhookUrl(),
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return true;
  }

  // POST /api/trackers/jira/webhook/:token — receive Jira dynamic-webhook events.
  //
  // Atlassian does not HMAC-sign OAuth 3LO dynamic webhooks (errata I8); we
  // authenticate via a URL-path token compared with `JIRA_WEBHOOK_TOKEN`.
  if (jiraWebhook.match(req.method, pathSegments)) {
    // Path token sits at index 4 of the matched segments
    // (["api","trackers","jira","webhook", null]). Use the route parser so
    // we go through the same Zod path-param plumbing the rest of the route
    // file uses.
    const queryParams = parseQueryParams(req.url || "");
    const parsed = await jiraWebhook.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true; // 400 already sent

    // Read raw body using the same chunk-assembly pattern as
    // src/http/trackers/linear.ts:166-171 — we don't trust the framework to
    // hand us a parsed body for webhook routes.
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();

    const result = await handleJiraWebhook(parsed.params.token, rawBody);

    // 401 with empty body — no info leak about valid-vs-missing token.
    if (result.status === 401) {
      res.writeHead(401);
      res.end();
      return true;
    }

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    return true;
  }

  return false;
}
