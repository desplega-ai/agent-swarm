import type { IncomingMessage, ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  ChatSdkActionError,
  ChatSdkStatusSchema,
  getChatSdkStatus,
  registerTelegramWebhook,
} from "../integrations/chat-sdk/status";
import { buildSlackManifest } from "../slack/manifest";
import { selectCredential } from "../utils/credentials";
import { ensureHttpPermission } from "./config";
import { resolveConfigValue, resolveMcpBaseUrl } from "./config-values";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal `client.beta.agents.retrieve` shape we depend on. Lets tests inject
 * a fake without pulling the entire SDK surface in.
 */
export interface ClaudeManagedTestClient {
  beta: {
    agents: {
      retrieve: (agentId: string) => Promise<{ name?: string | null; model?: string | null }>;
    };
  };
}

interface TestConnectionDeps {
  /**
   * Optional injectable client factory. When omitted, a real `Anthropic` SDK
   * client is constructed with the resolved API key.
   */
  buildClient?: (apiKey: string) => ClaudeManagedTestClient;
}

// ─── Response schemas ────────────────────────────────────────────────────────

const ClaudeManagedTestResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    agentName: z.string().nullable(),
    model: z.string().nullable(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);

const McpUserConfigSchema = z.object({
  mcpBaseUrl: z.string(),
  mcpUserUrl: z.string(),
});

const SlackManifestSchema = z.record(z.string(), z.unknown());

const TelegramRegisterWebhookSchema = z.object({
  webhookUrl: z.string(),
  webhookInfo: z.looseObject({
    url: z.string(),
    has_custom_certificate: z.boolean().optional(),
    pending_update_count: z.number().optional(),
    last_error_date: z.number().optional(),
    last_error_message: z.string().optional(),
    max_connections: z.number().optional(),
    ip_address: z.string().optional(),
    allowed_updates: z.array(z.string()).optional(),
  }),
});

// ─── Route Definition ────────────────────────────────────────────────────────

const claudeManagedTestRoute = route({
  method: "post",
  path: "/api/integrations/claude-managed/test",
  pattern: ["api", "integrations", "claude-managed", "test"],
  summary:
    "Test the claude-managed integration: resolves ANTHROPIC_API_KEY + MANAGED_AGENT_ID from swarm_config and calls beta.agents.retrieve.",
  tags: ["Integrations"],
  body: z.object({}).optional(),
  responses: {
    200: {
      description:
        "Connection result — `{ ok: true, agentName, model }` on success or `{ ok: false, error }` on any failure (missing config, Anthropic API error). Always 200 OK.",
      schema: ClaudeManagedTestResultSchema,
    },
  },
});

const mcpUserConfigRoute = route({
  method: "get",
  path: "/api/integrations/mcp-user/config",
  pattern: ["api", "integrations", "mcp-user", "config"],
  summary: "Get server-derived config for end-user MCP clients.",
  tags: ["Integrations"],
  responses: {
    200: {
      description:
        "Server-derived MCP user config. `mcpBaseUrl` is the API server base URL and `mcpUserUrl` appends `/mcp-user`.",
      schema: McpUserConfigSchema,
    },
  },
});

const slackManifestRoute = route({
  method: "get",
  path: "/api/integrations/slack/manifest",
  pattern: ["api", "integrations", "slack", "manifest"],
  summary: "Build a Slack app manifest for this swarm",
  tags: ["Integrations"],
  query: z.object({ name: z.string().optional() }),
  responses: {
    200: { description: "Slack app manifest", schema: SlackManifestSchema },
  },
});

const chatSdkStatusRoute = route({
  method: "get",
  path: "/api/integrations/chat/status",
  pattern: ["api", "integrations", "chat", "status"],
  summary:
    "Chat SDK channel status: enabled flag, Slack clash, per-adapter health and webhook URL.",
  tags: ["Integrations"],
  responses: {
    200: {
      description:
        "Per-adapter status. `health` is `disabled` for an adapter that is not running. Never contains secret values.",
      schema: ChatSdkStatusSchema,
    },
  },
});

const chatSdkTelegramRegisterWebhookRoute = route({
  method: "post",
  path: "/api/integrations/chat/telegram/register-webhook",
  pattern: ["api", "integrations", "chat", "telegram", "register-webhook"],
  summary:
    "Register this swarm's public Telegram webhook URL and secret token with the Bot API (setWebhook), then return getWebhookInfo.",
  tags: ["Integrations"],
  body: z.object({}).optional(),
  responses: {
    200: { description: "Webhook registered", schema: TelegramRegisterWebhookSchema },
    400: { description: "Telegram is not configured for webhook mode" },
    403: { description: "Only the lead agent or a dashboard user can register the webhook" },
    502: { description: "The Telegram Bot API rejected the call" },
  },
  rbac: { permission: "integration.chat.manage" },
});

// ─── Public handler factory ──────────────────────────────────────────────────

/**
 * Build the integrations handler. Exposed as a factory so tests can inject a
 * fake Anthropic client.
 */
export function createIntegrationsHandler(deps: TestConnectionDeps = {}) {
  const buildClient =
    deps.buildClient ??
    ((apiKey: string) =>
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the SDK client is a superset of this narrow test seam.
      new Anthropic({ apiKey }) as unknown as ClaudeManagedTestClient);

  return async function handleIntegrations(
    req: IncomingMessage,
    res: ServerResponse,
    pathSegments: string[],
    queryParams = new URLSearchParams(),
  ): Promise<boolean> {
    if (slackManifestRoute.match(req.method, pathSegments)) {
      const parsed = await slackManifestRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      slackManifestRoute.respond(res, 200, buildSlackManifest(parsed.query.name));
      return true;
    }

    if (chatSdkStatusRoute.match(req.method, pathSegments)) {
      chatSdkStatusRoute.respond(res, 200, await getChatSdkStatus());
      return true;
    }

    if (chatSdkTelegramRegisterWebhookRoute.match(req.method, pathSegments)) {
      const parsed = await chatSdkTelegramRegisterWebhookRoute.parse(
        req,
        res,
        pathSegments,
        queryParams,
      );
      if (!parsed) return true;
      // Operators and dashboard users pass; agents need the verb (lead-only
      // under the legacy policy).
      if (
        !(await ensureHttpPermission(
          req,
          res,
          "integration.chat.manage",
          "Registering the Telegram webhook requires the lead agent",
        ))
      ) {
        return true;
      }
      try {
        chatSdkTelegramRegisterWebhookRoute.respond(res, 200, await registerTelegramWebhook());
      } catch (error) {
        if (!(error instanceof ChatSdkActionError)) throw error;
        jsonError(res, error.message, error.status);
      }
      return true;
    }

    if (mcpUserConfigRoute.match(req.method, pathSegments)) {
      const mcpBaseUrl = await resolveMcpBaseUrl();
      mcpUserConfigRoute.respond(res, 200, { mcpBaseUrl, mcpUserUrl: `${mcpBaseUrl}/mcp-user` });
      return true;
    }

    if (claudeManagedTestRoute.match(req.method, pathSegments)) {
      const apiKey = await resolveConfigValue("ANTHROPIC_API_KEY");
      const agentId = await resolveConfigValue("MANAGED_AGENT_ID");

      if (!apiKey || !agentId) {
        const missing: string[] = [];
        if (!apiKey) missing.push("ANTHROPIC_API_KEY");
        if (!agentId) missing.push("MANAGED_AGENT_ID");
        claudeManagedTestRoute.respond(res, 200, {
          ok: false,
          error: `Missing required config: ${missing.join(", ")}. Run \`bun run src/cli.tsx claude-managed-setup\` to populate.`,
        });
        return true;
      }

      try {
        // A comma pool is one key per call, as the runner does.
        const client = buildClient(
          selectCredential(apiKey, undefined, "ANTHROPIC_API_KEY").selected,
        );
        const agent = await client.beta.agents.retrieve(agentId);
        // `agent.model` is `BetaManagedAgentsModelConfig` ({id, speed}). Flatten
        // to a string so the UI can render it directly without type guards.
        const modelId =
          typeof agent.model === "string"
            ? agent.model
            : ((agent.model as { id?: string } | null | undefined)?.id ?? null);
        claudeManagedTestRoute.respond(res, 200, {
          ok: true,
          agentName: agent.name ?? null,
          model: modelId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        claudeManagedTestRoute.respond(res, 200, { ok: false, error: message });
      }
      return true;
    }

    return false;
  };
}

// ─── Default singleton (used in production / OpenAPI generation) ─────────────

export const handleIntegrations = createIntegrationsHandler();
