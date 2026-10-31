import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { cleanupStack, deleteConfig, putConfig } from "./platform-helpers";

// Operator-facing integration status, the Slack app manifest, the MCP client config and the
// disabled contracts of the Chat SDK channel and the Claude Managed integration.

const CHAT_ADAPTERS = ["telegram", "slack", "discord", "teams"] as const;

export const platformIntegrations: Scenario = {
  name: "platform-integrations",
  order: 645,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    try {
      for (const [method, path] of [
        ["GET", "/api/integrations/chat/status"],
        ["GET", "/api/integrations/mcp-user/config"],
        ["GET", "/api/integrations/slack/app-icon"],
        ["GET", "/api/integrations/slack/manifest"],
        ["GET", "/api/slack/inbound/diagnostics"],
        ["POST", "/api/integrations/chat/telegram/register-webhook"],
        ["POST", "/api/integrations/claude-managed/test"],
      ] as const) {
        expectStatus(
          await ctx.api(method, path, { apiKey: null, body: method === "POST" ? {} : undefined }),
          [401],
          `${method} ${path} unauth`,
        );
      }

      // ── MCP client config ──────────────────────────────────────────────────
      const config = await ctx.api("GET", "/api/integrations/mcp-user/config");
      expectStatus(config, [200], "mcp-user config");
      const base = String(asRecord(config.json).mcpBaseUrl);
      expect(
        new URL(base).port === new URL(ctx.baseUrl).port &&
          asRecord(config.json).mcpUserUrl === `${base}/mcp-user`,
        `the config points MCP clients at this swarm's /mcp-user: ${config.text}`,
      );
      // The configured public origin wins, so a swarm behind a proxy advertises the right URL.
      const publicOrigin = `https://swarm-${ctx.nonce}.example.com`;
      const row = await putConfig(ctx, { key: "PUBLIC_MCP_BASE_URL", value: publicOrigin });
      cleanup.add("delete PUBLIC_MCP_BASE_URL", async () => {
        await ctx.api("DELETE", `/api/config/${String(row.id)}`);
      });
      const overridden = asRecord((await ctx.api("GET", "/api/integrations/mcp-user/config")).json);
      expect(
        overridden.mcpBaseUrl === publicOrigin &&
          overridden.mcpUserUrl === `${publicOrigin}/mcp-user`,
        "PUBLIC_MCP_BASE_URL overrides the advertised origin",
      );
      await deleteConfig(ctx, String(row.id));
      expect(
        asRecord((await ctx.api("GET", "/api/integrations/mcp-user/config")).json).mcpBaseUrl ===
          base,
        "removing the override restores the origin",
      );

      // ── Slack manifest and app icon ────────────────────────────────────────
      const manifest = await ctx.api("GET", "/api/integrations/slack/manifest");
      expectStatus(manifest, [200], "slack manifest");
      const body = asRecord(manifest.json);
      expect(
        ["display_information", "features", "oauth_config", "settings"].every((key) => key in body),
        "the manifest has display, features, oauth and settings blocks",
      );
      expect(
        asRecord(body.display_information).name === "Your Swarm",
        "the default app name is Your Swarm",
      );
      const scopes = asRecord(asRecord(body.oauth_config).scopes);
      expect(
        (scopes.bot as string[]).includes("chat:write") &&
          (scopes.bot as string[]).includes("app_mentions:read"),
        "the manifest requests the bot scopes the integration needs",
      );
      const settings = asRecord(body.settings);
      expect(settings.socket_mode_enabled === true, "the manifest uses socket mode");
      expect(
        (asRecord(settings.event_subscriptions).bot_events as string[]).includes("app_mention"),
        "the manifest subscribes to mentions",
      );
      expect(
        !("redirect_urls" in asRecord(body.oauth_config)),
        "the manifest carries no redirect urls",
      );
      const named = asRecord(
        (
          await ctx.api(
            "GET",
            `/api/integrations/slack/manifest?name=${encodeURIComponent(`E2E ${ctx.nonce}`)}`,
          )
        ).json,
      );
      expect(
        asRecord(named.display_information).name === `E2E ${ctx.nonce}` &&
          asRecord(asRecord(named.features).bot_user).display_name === `E2E ${ctx.nonce}`,
        "name sets the app and bot display names",
      );

      const icon = await ctx.api("GET", "/api/integrations/slack/app-icon");
      expectStatus(icon, [200], "slack app icon");
      const imageUrl = asRecord(icon.json).imageUrl;
      expect(
        imageUrl === null || typeof imageUrl === "string",
        "the icon is a url or null when the lookup has none",
      );

      // ── Slack inbound diagnostics ──────────────────────────────────────────
      const diagnostics = await ctx.api("GET", "/api/slack/inbound/diagnostics");
      expectStatus(diagnostics, [200], "slack inbound diagnostics");
      const report = asRecord(diagnostics.json);
      expect(
        ["socket", "http"].includes(String(report.mode)) && typeof report.disabled === "boolean",
        "diagnostics report the transport mode",
      );
      const counts = asRecord(asRecord(report.receipts).counts);
      for (const state of [
        "pending",
        "processing",
        "processed",
        "ignored",
        "failed",
        "uncertain",
      ]) {
        expect(typeof counts[state] === "number", `diagnostics count ${state} receipts`);
      }
      expect(
        Array.isArray(asRecord(report.receipts).uncertain),
        "diagnostics list uncertain receipts",
      );
      const outcomes = asRecord(report.outcomes);
      expect(
        typeof asRecord(outcomes.socket).processed === "number" &&
          typeof asRecord(outcomes.http).processed === "number",
        "diagnostics count outcomes per transport",
      );
      expect(
        typeof asRecord(report.limits).maxBacklogReceipts === "number",
        "diagnostics list the backlog limits",
      );
      expect(!/xox[bap]-|signing/i.test(diagnostics.text), "diagnostics never include credentials");

      // ── Chat SDK channel (disabled in the test SUT) ────────────────────────
      const status = await ctx.api("GET", "/api/integrations/chat/status");
      expectStatus(status, [200], "chat status");
      const chat = asRecord(status.json);
      expect(chat.enabled === false && chat.slackClash === false, "the Chat SDK channel is off");
      const adapters = asRecords(chat, "adapters");
      expect(
        adapters.map((a) => a.name).join() === CHAT_ADAPTERS.join(),
        "status lists the four adapters in order",
      );
      for (const adapter of adapters) {
        expect(
          adapter.configured === false &&
            adapter.enabled === false &&
            adapter.health === "disabled",
          `adapter ${adapter.name} is disabled`,
        );
        expect(
          String(adapter.webhookUrl).endsWith(`/api/integrations/chat/${adapter.name}/webhook`),
          `adapter ${adapter.name} advertises its webhook url`,
        );
      }

      const register = await ctx.api("POST", "/api/integrations/chat/telegram/register-webhook", {
        body: {},
      });
      expectStatus(register, [400], "register the telegram webhook while the channel is off");
      expect(
        String(asRecord(register.json).error).includes("CHAT_SDK_ENABLED"),
        "the 400 tells the operator to enable the channel",
      );

      for (const adapter of [...CHAT_ADAPTERS, `unknown-${ctx.nonce}`]) {
        const response = await ctx.api("POST", `/api/integrations/chat/${adapter}/webhook`, {
          apiKey: null,
          body: { update_id: 1 },
        });
        expectStatus(response, [404], `chat webhook ${adapter}`);
        expect(
          asRecord(response.json).error === "Chat SDK adapter not configured",
          `chat webhook ${adapter} says the adapter is not configured`,
        );
      }
      const status2 = asRecord((await ctx.api("GET", "/api/integrations/chat/status")).json);
      expect(status2.enabled === false, "webhook probes leave the channel off");

      // ── Claude Managed connection test ─────────────────────────────────────
      const missing = await ctx.api("POST", "/api/integrations/claude-managed/test", { body: {} });
      expectStatus(missing, [200], "claude-managed test without config");
      expect(
        asRecord(missing.json).ok === false &&
          String(asRecord(missing.json).error).includes("ANTHROPIC_API_KEY") &&
          String(asRecord(missing.json).error).includes("MANAGED_AGENT_ID"),
        `the test lists the missing config: ${missing.text}`,
      );
      // Always 200: a failure is reported in the body. With only the agent id set, only the key is missing.
      const agentRow = await putConfig(ctx, {
        key: "MANAGED_AGENT_ID",
        value: `agent_${ctx.nonce}`,
      });
      cleanup.add("delete MANAGED_AGENT_ID", async () => {
        await ctx.api("DELETE", `/api/config/${String(agentRow.id)}`);
      });
      const partial = await ctx.api("POST", "/api/integrations/claude-managed/test", { body: {} });
      expectStatus(partial, [200], "claude-managed test with an agent id only");
      expect(
        asRecord(partial.json).ok === false &&
          String(asRecord(partial.json).error).includes("ANTHROPIC_API_KEY") &&
          !String(asRecord(partial.json).error).includes("MANAGED_AGENT_ID"),
        `only the API key is reported missing: ${partial.text}`,
      );
    } finally {
      await cleanup.run();
    }
  },
};
