import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  deleteOAuthTokens,
  getAuthorizationById,
  getDefaultAuthorizationIdForProvider,
  getOAuthTokens,
} from "../../be/db-queries/oauth";
import { isJiraEnabled } from "../../jira/app";
import { clearJiraMetadata, getJiraMetadata } from "../../jira/metadata";
import { getJiraAuthorizationUrl } from "../../jira/oauth";
import { handleJiraWebhook } from "../../jira/webhook";
import { deleteJiraWebhook, registerJiraWebhook } from "../../jira/webhook-lifecycle";
import { forceRefreshAuthorizationOrThrow } from "../../oauth/ensure-token";
import { completeGenericOAuthCallback } from "../oauth-callback";
import { route } from "../route-def";
import { deriveApiBaseUrl, parseQueryParams } from "../utils";

const MANUAL_WEBHOOK_INSTRUCTIONS =
  "See docs-site/.../guides/jira-integration.mdx for manual webhook registration steps.";

// ─── Response Schemas ────────────────────────────────────────────────────────

const JiraWebhookIdEntrySchema = z.object({
  id: z.number().int(),
  expiresAt: z.string(),
  jql: z.string(),
});

/** Shape returned by both GET /status and POST /refresh (buildJiraStatusPayload). */
const JiraStatusPayloadSchema = z.object({
  provider: z.literal("jira"),
  connected: z.boolean(),
  cloudId: z.string().nullable(),
  siteUrl: z.string().nullable(),
  tokenExpiresAt: z.string().nullable(),
  scope: z.string().nullable(),
  hasManageWebhookScope: z.boolean(),
  webhookTokenConfigured: z.boolean(),
  webhookUrl: z.string(),
  redirectUri: z.string(),
  webhookIds: z.array(JiraWebhookIdEntrySchema),
  // Only present when the OAuth grant lacks `manage:jira-webhook` scope.
  manualWebhookInstructions: z.string().optional(),
});

type JiraStatusPayload = z.infer<typeof JiraStatusPayloadSchema>;

/** Body shape of handleJiraWebhook's WebhookResult when status === 200. */
const JiraWebhookEventResultSchema = z.union([
  z.object({ status: z.literal("accepted") }),
  z.object({ status: z.literal("duplicate") }),
  z.object({ status: z.literal("ignored"), reason: z.literal("invalid-json") }),
]);

type JiraWebhookEventResult = z.infer<typeof JiraWebhookEventResultSchema>;

const JiraWebhookRegisteredSchema = z.object({
  webhookId: z.number().int(),
  expiresAt: z.string(),
  jql: z.string(),
});

const JiraWebhookDeletedSchema = z.object({
  deleted: z.literal(true),
  webhookId: z.number().int(),
});

const JiraDisconnectResultSchema = z.object({
  disconnected: z.literal(true),
  webhooksDeleted: z.number().int().nonnegative(),
  webhooksTotal: z.number().int().nonnegative(),
  webhookFailures: z.array(z.object({ id: z.number().int(), error: z.string() })),
  revokeNote: z.string(),
});

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
    200: {
      description: "OAuth complete",
      unstructured:
        "Delegates to completeGenericOAuthCallback (src/http/oauth-callback.ts), which sends an HTML success page or a redirect on success — never a fixed JSON shape",
    },
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
    200: { description: "Connection status", schema: JiraStatusPayloadSchema },
    503: { description: "Jira integration not configured" },
  },
});

const jiraRefresh = route({
  method: "post",
  path: "/api/trackers/jira/refresh",
  pattern: ["api", "trackers", "jira", "refresh"],
  summary:
    "Force a Jira OAuth token refresh and return the updated status payload. Useful when an agent observes an expired token via tracker-status / db-query and wants to recover without restarting the server or re-running 3LO.",
  tags: ["Trackers"],
  responses: {
    200: {
      description: "Token refreshed; returns same shape as /status",
      schema: JiraStatusPayloadSchema,
    },
    409: { description: "Jira not connected (no refresh token stored)" },
    500: { description: "Refresh failed (e.g. revoked grant, network error)" },
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
    200: { description: "Event accepted", schema: JiraWebhookEventResultSchema },
    401: { description: "Invalid URL token" },
    503: { description: "Jira webhook handler not configured" },
  },
});

// Admin: register a new dynamic webhook with Atlassian. apiKey is required
// (route-factory default). The registered URL embeds JIRA_WEBHOOK_TOKEN so
// inbound deliveries can be authenticated.
const jiraWebhookRegister = route({
  method: "post",
  path: "/api/trackers/jira/webhook-register",
  pattern: ["api", "trackers", "jira", "webhook-register"],
  summary: "Register a Jira dynamic webhook (admin only)",
  tags: ["Trackers"],
  body: z.object({
    jqlFilter: z.string().min(1),
  }),
  responses: {
    200: { description: "Webhook registered", schema: JiraWebhookRegisteredSchema },
    400: { description: "Invalid jqlFilter" },
    503: { description: "Jira not connected or JIRA_WEBHOOK_TOKEN missing" },
  },
});

// Admin: delete a dynamic webhook from Atlassian and remove from local
// metadata. apiKey is required (route-factory default).
const jiraWebhookDelete = route({
  method: "delete",
  path: "/api/trackers/jira/webhook/{id}",
  pattern: ["api", "trackers", "jira", "webhook", null],
  summary: "Delete a Jira dynamic webhook (admin only)",
  tags: ["Trackers"],
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  responses: {
    200: { description: "Webhook deleted", schema: JiraWebhookDeletedSchema },
    400: { description: "Invalid webhook id" },
    503: { description: "Jira not connected" },
  },
});

// Admin: full disconnect — delete all registered Atlassian webhooks, drop
// stored OAuth tokens, and clear cloudId/siteUrl/webhookIds metadata. Atlassian
// 3LO has no public token revocation endpoint, so the OAuth grant itself must
// be revoked by the user via id.atlassian.com → Connected apps.
const jiraDisconnect = route({
  method: "delete",
  path: "/api/trackers/jira/disconnect",
  pattern: ["api", "trackers", "jira", "disconnect"],
  summary: "Fully disconnect Jira: delete all webhooks, drop tokens, clear metadata",
  tags: ["Trackers"],
  responses: {
    200: { description: "Disconnected", schema: JiraDisconnectResultSchema },
    503: { description: "Jira not configured" },
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWebhookUrl(req: IncomingMessage): string {
  const token = process.env.JIRA_WEBHOOK_TOKEN ?? "<unset>";
  return `${deriveApiBaseUrl(req)}/api/trackers/jira/webhook/${token}`;
}

function getRedirectUri(req: IncomingMessage): string {
  // Mirror src/jira/app.ts: prefer the explicit JIRA_REDIRECT_URI override,
  // otherwise derive from the API base URL. Keeps the UI display consistent
  // with the URI persisted into oauth_apps and used in the actual OAuth flow.
  const override = process.env.JIRA_REDIRECT_URI?.trim();
  if (override) return override;
  return `${deriveApiBaseUrl(req)}/api/trackers/jira/callback`;
}

async function buildJiraStatusPayload(req: IncomingMessage): Promise<JiraStatusPayload> {
  const tokens = await getOAuthTokens("jira");
  const meta = await getJiraMetadata();
  const scope = tokens?.scope ?? null;
  // Atlassian returns scopes space-separated in the token response.
  const scopeList = scope ? scope.split(/[\s,]+/).filter(Boolean) : [];
  const hasManageWebhookScope = scopeList.includes("manage:jira-webhook");

  const status: JiraStatusPayload = {
    provider: "jira",
    connected: !!tokens,
    cloudId: meta.cloudId ?? null,
    siteUrl: meta.siteUrl ?? null,
    tokenExpiresAt: tokens?.expiresAt ?? null,
    scope,
    hasManageWebhookScope,
    webhookTokenConfigured: Boolean(process.env.JIRA_WEBHOOK_TOKEN),
    webhookUrl: getWebhookUrl(req),
    redirectUri: getRedirectUri(req),
    webhookIds: meta.webhookIds ?? [],
  };

  // Phase 5: surface manual-webhook instructions when the OAuth grant
  // doesn't include `manage:jira-webhook` (admin must register webhooks
  // manually in the Atlassian UI).
  if (!hasManageWebhookScope) {
    status.manualWebhookInstructions = MANUAL_WEBHOOK_INSTRUCTIONS;
  }

  return status;
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

    // Delegate to the unified, state-keyed callback. The redirect URI still
    // points here (registered with Atlassian), so this route stays valid; it
    // now consumes the DB-backed pending row, lands tokens on the default
    // authorization, and runs the tracker post-processing (cloudId capture).
    const { handled } = await completeGenericOAuthCallback(res, parsed.query);
    if (!handled) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or expired OAuth state" }));
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

    jiraStatus.respond(res, 200, await buildJiraStatusPayload(req));
    return true;
  }

  // POST /api/trackers/jira/refresh — force-refresh the access token and
  // return the same shape as /status. Useful when an agent observes a stale
  // token (via tracker-status / db-query MCP) and needs to recover in-band.
  if (jiraRefresh.match(req.method, pathSegments)) {
    if (!isJiraEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Jira integration not configured" }));
      return true;
    }

    const authorizationId = await getDefaultAuthorizationIdForProvider("jira");
    const authorization = authorizationId ? await getAuthorizationById(authorizationId) : null;
    if (!authorization?.refreshToken) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Jira not connected — no refresh token stored. Run 3LO via /authorize.",
        }),
      );
      return true;
    }

    try {
      // Unconditional refresh of the default authorization (force buffer).
      await forceRefreshAuthorizationOrThrow(authorizationId as string);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Jira] Forced token refresh failed:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Token refresh failed", details: message }));
      return true;
    }

    jiraRefresh.respond(res, 200, await buildJiraStatusPayload(req));
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

    if (result.status === 200) {
      jiraWebhook.respond(res, 200, result.body as JiraWebhookEventResult);
      return true;
    }

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    return true;
  }

  // POST /api/trackers/jira/webhook-register — admin: register a dynamic webhook.
  if (jiraWebhookRegister.match(req.method, pathSegments)) {
    if (!isJiraEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Jira integration not configured" }));
      return true;
    }
    if (!process.env.JIRA_WEBHOOK_TOKEN) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "JIRA_WEBHOOK_TOKEN is not set" }));
      return true;
    }

    const queryParams = parseQueryParams(req.url || "");
    const parsed = await jiraWebhookRegister.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const result = await registerJiraWebhook(parsed.body.jqlFilter);
      jiraWebhookRegister.respond(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Jira] Webhook register failed:", message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Webhook registration failed", details: message }));
    }
    return true;
  }

  // DELETE /api/trackers/jira/webhook/:id — admin: delete a dynamic webhook.
  // Note: this pattern overlaps the POST /webhook/:token path; the matcher
  // disambiguates by HTTP method.
  if (jiraWebhookDelete.match(req.method, pathSegments)) {
    if (!isJiraEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Jira integration not configured" }));
      return true;
    }

    const queryParams = parseQueryParams(req.url || "");
    const parsed = await jiraWebhookDelete.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      await deleteJiraWebhook(parsed.params.id);
      jiraWebhookDelete.respond(res, 200, { deleted: true, webhookId: parsed.params.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Jira] Webhook delete failed (id=${parsed.params.id}):`, message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Webhook delete failed", details: message }));
    }
    return true;
  }

  // DELETE /api/trackers/jira/disconnect — full cleanup.
  if (jiraDisconnect.match(req.method, pathSegments)) {
    if (!isJiraEnabled()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Jira integration not configured" }));
      return true;
    }

    const meta = await getJiraMetadata();
    const ids = (meta.webhookIds ?? []).map((entry) => entry.id);

    let webhooksDeleted = 0;
    const webhookFailures: Array<{ id: number; error: string }> = [];
    for (const id of ids) {
      try {
        await deleteJiraWebhook(id);
        webhooksDeleted++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[Jira] Disconnect: webhook delete failed (id=${id}): ${message}`);
        webhookFailures.push({ id, error: message });
      }
    }

    await deleteOAuthTokens("jira");
    await clearJiraMetadata();

    console.log(
      `[Jira] Disconnected: ${webhooksDeleted}/${ids.length} webhooks deleted, tokens cleared, metadata reset`,
    );

    jiraDisconnect.respond(res, 200, {
      disconnected: true,
      webhooksDeleted,
      webhooksTotal: ids.length,
      webhookFailures,
      // Atlassian 3LO has no token revocation endpoint — surface this so
      // the UI can prompt the user to revoke the grant manually if desired.
      revokeNote:
        "Atlassian OAuth grants must be revoked manually at https://id.atlassian.com/manage/connected-apps if you want to fully sever the consent.",
    });
    return true;
  }

  return false;
}
