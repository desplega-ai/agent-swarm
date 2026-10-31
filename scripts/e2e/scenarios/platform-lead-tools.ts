import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  cleanupStack,
  expectToolError,
  expectToolOk,
  hmacSignature,
  jsonResponse,
  putConfig,
  registerAgent,
  startMockServer,
} from "./platform-helpers";

// The tools only a lead agent may use fully: writing and deleting swarm config, swarm-scope and
// cross-agent MCP server management, and the Kapso WhatsApp number registry with its signed
// inbound webhook. This scenario registers one dedicated lead; a lead changes task routing for
// every later scenario, so it runs last in the platform band and uses a worker as the target.

export const platformLeadTools: Scenario = {
  name: "platform-lead-tools",
  order: 649,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const prefix = `E2E_LEAD_${ctx.nonce.toUpperCase()}`;
    const leadId = await registerAgent(ctx, "lead", { lead: true });
    const workerId = await registerAgent(ctx, "lead-target");
    const lead = await ctx.connectMcp(leadId);
    const worker = await ctx.connectMcp(workerId);
    try {
      // ── set-config ─────────────────────────────────────────────────────────
      const plainKey = `${prefix}_PLAIN`;
      const secretKey = `${prefix}_SECRET`;
      const scopedKey = `${prefix}_SCOPED`;
      const set = expectToolOk(
        await callTool(lead, "set-config", {
          scope: "global",
          key: plainKey,
          value: "one",
          description: "set by the lead",
        }),
        "set-config global",
      );
      const plain = asRecord(set.data.config);
      cleanup.add("delete the plain row", async () => {
        await ctx.api("DELETE", `/api/config/${String(plain.id)}`);
      });
      expect(
        plain.key === plainKey &&
          plain.value === "one" &&
          plain.scope === "global" &&
          plain.scopeId === null &&
          plain.description === "set by the lead",
        `set-config returns the stored row: ${JSON.stringify(plain)}`,
      );
      expect(set.message === `Config "${plainKey}" set successfully.`, "set-config names the key");
      const again = expectToolOk(
        await callTool(lead, "set-config", { scope: "global", key: plainKey, value: "two" }),
        "set-config again",
      );
      expect(
        asRecord(again.data.config).id === plain.id && asRecord(again.data.config).value === "two",
        "set-config upserts the same row",
      );

      const secret = expectToolOk(
        await callTool(lead, "set-config", {
          scope: "global",
          key: secretKey,
          value: `s3cret-${ctx.nonce}`,
          isSecret: true,
        }),
        "set-config secret",
      );
      const secretRow = asRecord(secret.data.config);
      cleanup.add("delete the secret row", async () => {
        await ctx.api("DELETE", `/api/config/${String(secretRow.id)}`);
      });
      expect(
        secretRow.value === "********" && secretRow.isSecret === true,
        "set-config masks the secret it returns",
      );
      expect(
        !secret.text.includes(`s3cret-${ctx.nonce}`),
        "the secret never reaches the tool text",
      );
      const stored = ctx.db.get<{ value: string; encrypted: number }>(
        "SELECT value, encrypted FROM swarm_config WHERE id = ?",
        [String(secretRow.id)],
      );
      expect(
        stored?.encrypted === 1 && stored.value !== `s3cret-${ctx.nonce}`,
        "the secret is stored encrypted",
      );

      const scoped = expectToolOk(
        await callTool(lead, "set-config", {
          scope: "agent",
          scopeId: workerId,
          key: scopedKey,
          value: "agent-value",
          exportToEnv: false,
        }),
        "set-config agent scope",
      );
      cleanup.add("delete the agent row", async () => {
        await ctx.api("DELETE", `/api/config/${String(asRecord(scoped.data.config).id)}`);
      });
      expect(
        asRecord(scoped.data.config).scopeId === workerId &&
          asRecord(scoped.data.config).exportToEnv === false,
        "set-config honours scopeId and exportToEnv",
      );

      expectToolError(
        await callTool(lead, "set-config", { scope: "agent", key: scopedKey, value: "x" }),
        "set-config agent scope without scopeId",
        "scopeId is required",
      );
      expectToolError(
        await callTool(lead, "set-config", { scope: "global", key: "API_KEY", value: "x" }),
        "set-config reserved key",
        "reserved",
      );
      expectToolError(
        await callTool(lead, "set-config", {
          scope: "global",
          key: "onboarding_state",
          value: "x",
        }),
        "set-config internal key",
        "managed by",
      );
      expectToolError(
        await callTool(lead, "set-config", {
          scope: "global",
          key: "RUNTIME_DEFAULT_DELIVERY",
          value: "carrier-pigeon",
        }),
        "set-config invalid value",
        "must be one of",
      );
      expectToolError(
        await callTool(lead, "set-config", {
          scope: "global",
          key: "SLACK_SIGNING_SECRET",
          value: "x",
          exportToEnv: true,
        }),
        "set-config API-only key exported to env",
        "exportToEnv: false",
      );
      expect(
        (await callTool(lead, "set-config", { scope: "planet", key: plainKey, value: "x" }))
          .isError,
        "set-config rejects an unknown scope",
      );
      expect(
        ctx.db.get(
          "SELECT 1 AS one FROM swarm_config WHERE key IN ('API_KEY', 'onboarding_state', 'RUNTIME_DEFAULT_DELIVERY', 'SLACK_SIGNING_SECRET') AND lastUpdatedAt >= ?",
          [String(plain.createdAt)],
        ) === null,
        "refused writes persist nothing",
      );

      // The lead may read secrets back; a worker may not.
      const leadGet = expectToolOk(
        await callTool(lead, "get-config", { key: secretKey, includeSecrets: true }),
        "get-config as the lead",
      );
      expect(
        (leadGet.data.configs as Array<Record<string, unknown>>)[0]?.value ===
          `s3cret-${ctx.nonce}`,
        "the lead reads the secret unmasked",
      );
      expect(!leadGet.message.includes("requires the lead agent"), "the lead gets no masking note");
      const leadList = expectToolOk(
        await callTool(lead, "list-config", { key: secretKey, includeSecrets: true }),
        "list-config as the lead",
      );
      expect(
        (leadList.data.configs as Array<Record<string, unknown>>)[0]?.value ===
          `s3cret-${ctx.nonce}`,
        "list-config reveals secrets to the lead",
      );
      const workerGet = expectToolOk(
        await callTool(worker, "get-config", { key: secretKey, includeSecrets: true }),
        "get-config as a worker",
      );
      expect(
        (workerGet.data.configs as Array<Record<string, unknown>>)[0]?.value === "********",
        "a worker still gets the secret masked",
      );
      const scopedGet = expectToolOk(
        await callTool(worker, "get-config", { agentId: workerId, key: scopedKey }),
        "get-config for the agent scope",
      );
      expect(
        (scopedGet.data.configs as Array<Record<string, unknown>>)[0]?.value === "agent-value",
        "the agent-scope row resolves for its agent",
      );

      // ── delete-config ──────────────────────────────────────────────────────
      expect(
        (await callTool(lead, "delete-config", { id: "not-a-uuid" })).isError,
        "delete-config rejects a non-uuid id",
      );
      expectToolError(
        await callTool(lead, "delete-config", { id: crypto.randomUUID() }),
        "delete-config unknown id",
        "not found",
      );
      const internal = ctx.db.get<{ id: string }>(
        "SELECT id FROM swarm_config WHERE key = 'onboarding_state'",
      );
      if (internal) {
        expectToolError(
          await callTool(lead, "delete-config", { id: internal.id }),
          "delete-config internal row",
          "managed by",
        );
        expect(
          ctx.db.get("SELECT 1 AS one FROM swarm_config WHERE id = ?", [internal.id]) !== null,
          "the internal row survives",
        );
      }
      const deleted = expectToolOk(
        await callTool(lead, "delete-config", { id: String(plain.id) }),
        "delete-config",
      );
      expect(
        deleted.message === `Config "${plainKey}" deleted successfully.`,
        "delete-config names the key",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM swarm_config WHERE id = ?", [String(plain.id)]) === null,
        "the row is gone",
      );
      expectToolError(
        await callTool(lead, "delete-config", { id: String(plain.id) }),
        "delete-config twice",
        "not found",
      );

      // ── MCP servers: lead-only scopes and cross-agent management ───────────
      const url = `https://lead-${ctx.nonce}.example.com/mcp`;
      const swarmServer = expectToolOk(
        await callTool(lead, "mcp-server-create", {
          name: `e2e-lead-swarm-${ctx.nonce}`,
          transport: "http",
          url,
          scope: "swarm",
        }),
        "mcp-server-create swarm scope as the lead",
      );
      const swarmId = String(asRecord(swarmServer.data.server).id);
      cleanup.add("delete the swarm server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${swarmId}`);
      });
      expect(
        asRecord(swarmServer.data.server).scope === "swarm",
        "a lead can create swarm-scope servers",
      );
      const stdioServer = expectToolOk(
        await callTool(lead, "mcp-server-create", {
          name: `e2e-lead-stdio-${ctx.nonce}`,
          transport: "stdio",
          command: "echo",
          args: JSON.stringify(["hi"]),
        }),
        "mcp-server-create stdio as the lead",
      );
      const stdioId = String(asRecord(stdioServer.data.server).id);
      cleanup.add("delete the stdio server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${stdioId}`);
      });
      expect(
        asRecord(stdioServer.data.server).command === "echo",
        "a lead can create stdio servers",
      );
      expectToolError(
        await callTool(worker, "mcp-server-update", { id: stdioId, command: "rm" }),
        "mcp-server-update of a stdio command by a worker",
        "owning agent or lead",
      );

      // The lead installs and uninstalls for another agent, and manages a server it does not own.
      const workerServer = expectToolOk(
        await callTool(worker, "mcp-server-create", {
          name: `e2e-worker-${ctx.nonce}`,
          transport: "http",
          url,
        }),
        "worker creates an agent-scope server",
      );
      const workerServerId = String(asRecord(workerServer.data.server).id);
      cleanup.add("delete the worker server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${workerServerId}`);
      });
      expectToolOk(
        await callTool(lead, "mcp-server-install", { mcpServerId: swarmId, agentId: workerId }),
        "lead installs for another agent",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM agent_mcp_servers WHERE agentId = ? AND mcpServerId = ?", [
          workerId,
          swarmId,
        ]) !== null,
        "the cross-agent install is persisted",
      );
      expectToolOk(
        await callTool(lead, "mcp-server-uninstall", { mcpServerId: swarmId, agentId: workerId }),
        "lead uninstalls for another agent",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM agent_mcp_servers WHERE agentId = ? AND mcpServerId = ?", [
          workerId,
          swarmId,
        ]) === null,
        "the cross-agent uninstall is persisted",
      );
      const leadUpdate = expectToolOk(
        await callTool(lead, "mcp-server-update", {
          id: workerServerId,
          description: "touched by the lead",
        }),
        "lead updates a server it does not own",
      );
      expect(
        asRecord(leadUpdate.data.server).description === "touched by the lead",
        "the lead's update lands",
      );
      expectToolOk(
        await callTool(lead, "mcp-server-delete", { id: workerServerId }),
        "lead deletes a server it does not own",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM mcp_servers WHERE id = ?", [workerServerId]) === null,
        "the lead's delete lands",
      );

      // ── Kapso: register a number, receive a signed message, unregister ─────
      const phoneNumberId = `pn-lead-${ctx.nonce}`;
      const hmacSecret = `kapso-secret-${ctx.nonce}`;
      const webhooks: Array<{ url: string; kind: string; secret_key?: string }> = [];
      const kapso = startMockServer((request) => {
        if (request.path.endsWith("/webhooks")) {
          if (request.method === "GET") return jsonResponse({ whatsapp_webhooks: webhooks });
          const created = asRecord(asRecord(request.json).whatsapp_webhook);
          webhooks.push({
            url: String(created.url),
            kind: String(created.kind),
            secret_key: created.secret_key as string | undefined,
          });
          return jsonResponse({ ok: true }, 201);
        }
        return jsonResponse({}, 404);
      });
      cleanup.add("stop kapso mock", async () => kapso.stop());
      const trackConfig = async (key: string, value: string, isSecret = false) => {
        const row = await putConfig(ctx, { key, value, isSecret });
        cleanup.add(`delete ${key}`, async () => {
          await ctx.api("DELETE", `/api/config/${String(row.id)}`);
        });
      };
      await trackConfig("KAPSO_WEBHOOK_HMAC_SECRET", hmacSecret, true);
      const mapping = () =>
        ctx.db.get<{ value: string }>(
          "SELECT value FROM kv_entries WHERE namespace = 'integrations:kapso:numbers' AND key = ?",
          [phoneNumberId],
        );
      cleanup.add("unregister the number", async () => {
        await callTool(lead, "unregister-kapso-number", { phoneNumberId });
      });

      // Without an API key the number is still mapped; only the provider-side webhook is skipped.
      const keyless = expectToolOk(
        await callTool(lead, "register-kapso-number", {
          phoneNumberId,
          agentId: workerId,
          name: "E2E line",
        }),
        "register-kapso-number without an API key",
      );
      expect(
        keyless.data.webhookRegistered === false &&
          keyless.text.includes("KAPSO_API_KEY not configured"),
        "no API key means no provider-side registration",
      );
      expect(JSON.parse(mapping()?.value ?? "{}").agentId === workerId, "the mapping is stored");

      await trackConfig("KAPSO_API_KEY", `kapso_${ctx.nonce}`, true);
      await trackConfig("KAPSO_API_BASE_URL", kapso.origin);
      const registered = expectToolOk(
        await callTool(lead, "register-kapso-number", {
          phoneNumberId,
          agentId: workerId,
          name: "E2E line",
        }),
        "register-kapso-number",
      );
      const webhookUrl = String(registered.data.webhookUrl);
      expect(
        webhookUrl.endsWith("/api/integrations/kapso/webhook"),
        `the registered webhook is the native handler: ${webhookUrl}`,
      );
      expect(registered.data.webhookRegistered === true, "the provider-side webhook is registered");
      const stored2 = asRecord(registered.data.mapping);
      expect(
        stored2.phoneNumberId === phoneNumberId &&
          stored2.agentId === workerId &&
          stored2.name === "E2E line" &&
          typeof stored2.createdAt === "string",
        "the mapping carries number, agent, name and time",
      );
      expect(
        webhooks.length === 1 &&
          webhooks[0]?.url === webhookUrl &&
          webhooks[0]?.kind === "kapso" &&
          webhooks[0]?.secret_key === hmacSecret,
        "the provider webhook is created with the swarm's HMAC secret",
      );
      expect(
        kapso.requests.some(
          (r) =>
            r.method === "POST" &&
            r.path === `/platform/v1/whatsapp/phone_numbers/${phoneNumberId}/webhooks` &&
            r.headers.get("x-api-key") === `kapso_${ctx.nonce}`,
        ),
        "the registration call authenticates with the Kapso API key",
      );
      const repeat = expectToolOk(
        await callTool(lead, "register-kapso-number", { phoneNumberId, agentId: workerId }),
        "register-kapso-number again",
      );
      expect(
        repeat.text.includes("already registered") && webhooks.length === 1,
        "registering twice does not duplicate the provider webhook",
      );

      // A signed inbound message becomes a kapso-inbound task for the mapped agent.
      const send = (body: string) =>
        ctx.api("POST", "/api/integrations/kapso/webhook", {
          apiKey: null,
          rawBody: body,
          headers: { "X-Webhook-Signature": hmacSignature(hmacSecret, body) },
        });
      const messageId = `wamid-${ctx.nonce}`;
      const inbound = JSON.stringify({
        phone_number_id: phoneNumberId,
        conversation: { id: `conv-${ctx.nonce}` },
        message: {
          id: messageId,
          from: "34600000002",
          type: "text",
          text: { body: `where is my order ${ctx.nonce}` },
          kapso: { direction: "inbound" },
        },
      });
      const delivered = await send(inbound);
      expectStatus(delivered, [200], "signed inbound message");
      expect(
        asRecord(delivered.json).received === true && asRecord(delivered.json).routing === "task",
        `an inbound message is routed to a task: ${delivered.text}`,
      );
      const task = ctx.db.get<{
        agentId: string | null;
        taskType: string;
        priority: number;
        source: string;
        tags: string;
      }>(
        "SELECT agentId, taskType, priority, source, tags FROM agent_tasks WHERE taskType = 'kapso-inbound' AND task LIKE ?",
        [`%${ctx.nonce}%`],
      );
      expect(
        task?.agentId === workerId && task.source === "system" && task.priority === 70,
        `the task is pinned to the mapped agent: ${JSON.stringify(task)}`,
      );
      expect(String(task?.tags).includes("kapso-whatsapp"), "the task is tagged kapso-whatsapp");
      expect(
        asRecord((await send(inbound)).json).routing === "duplicate",
        "a redelivered message is not routed twice",
      );
      expect(
        ctx.db.query(
          "SELECT id FROM agent_tasks WHERE taskType = 'kapso-inbound' AND task LIKE ?",
          [`%${ctx.nonce}%`],
        ).length === 1,
        "the redelivery created no second task",
      );

      // A mapping can target a workflow instead; an unknown workflow is reported, not retried.
      const workflowNumber = `${phoneNumberId}-wf`;
      cleanup.add("unregister the workflow number", async () => {
        await callTool(lead, "unregister-kapso-number", { phoneNumberId: workflowNumber });
      });
      expectToolOk(
        await callTool(lead, "register-kapso-number", {
          phoneNumberId: workflowNumber,
          workflowId: crypto.randomUUID(),
        }),
        "register a workflow number",
      );
      const viaWorkflow = JSON.stringify({
        phone_number_id: workflowNumber,
        message: {
          id: `wamid-wf-${ctx.nonce}`,
          from: "34600000003",
          type: "text",
          text: { body: "hi" },
          kapso: { direction: "inbound" },
        },
      });
      expect(
        asRecord((await send(viaWorkflow)).json).routing === "error",
        "a message for a missing workflow is acknowledged with routing error",
      );
      expect(
        (
          await callTool(lead, "register-kapso-number", {
            phoneNumberId: "pn",
            workflowId: "not-a-uuid",
          })
        ).isError,
        "register-kapso-number rejects a non-uuid workflow id",
      );

      const unregistered = expectToolOk(
        await callTool(lead, "unregister-kapso-number", { phoneNumberId }),
        "unregister-kapso-number",
      );
      expect(
        unregistered.message === `Unregistered Kapso number ${phoneNumberId}`,
        "unregister names the number",
      );
      expect(mapping() === null, "the mapping is deleted");
      expectToolError(
        await callTool(lead, "unregister-kapso-number", { phoneNumberId }),
        "unregister-kapso-number twice",
        "No mapping found",
      );
      const orphan = JSON.stringify({
        phone_number_id: phoneNumberId,
        message: {
          id: `wamid-after-${ctx.nonce}`,
          from: "34600000004",
          type: "text",
          text: { body: "hello?" },
          kapso: { direction: "inbound" },
        },
      });
      expect(
        asRecord((await send(orphan)).json).routing === "no_mapping",
        "after unregistering, inbound messages have no routing",
      );
    } finally {
      await lead.close();
      await worker.close();
      // Deleting global config schedules a debounced integrations reload that restarts the Slack
      // app. This is the last scenario of the platform band, so wait for that restart instead of
      // handing a reconnecting Slack to the next scenario.
      const slackOpens = () => ctx.slack.apiCalls("apps.connections.open").length;
      const opensBefore = slackOpens();
      await cleanup.run();
      await pollUntil(() => slackOpens() > opensBefore, 10_000, 100);
      await ctx.slack.waitForConnection(30_000);
    }
  },
};
