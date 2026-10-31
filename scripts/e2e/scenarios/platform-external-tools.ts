import { asRecord, asRecords, expect } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  cleanupStack,
  expectToolError,
  expectToolOk,
  jsonResponse,
  putConfig,
  registerAgent,
  reloadConfig,
  startMockServer,
} from "./platform-helpers";

// Worker-callable tools that reach third-party services: the Composio router (swarm_x),
// WhatsApp through Kapso, and AgentMail inbox mappings. The third parties are loopback
// stand-ins configured through swarm_config, so the requests the swarm makes are asserted
// as well as the tool results. The lead-only Kapso number registration is in
// platform-lead-tools.

const KAPSO_NUMBERS = "integrations:kapso:numbers";

export const platformExternalTools: Scenario = {
  name: "platform-external-tools",
  order: 647,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const track = async (key: string, value: string, isSecret = false) => {
      const row = await putConfig(ctx, { key, value, isSecret });
      cleanup.add(`delete ${key}`, async () => {
        await ctx.api("DELETE", `/api/config/${String(row.id)}`);
      });
      return String(row.id);
    };
    const agentId = await registerAgent(ctx, "external");
    const otherId = await registerAgent(ctx, "external-other");
    const worker = await ctx.connectMcp(agentId);
    const other = await ctx.connectMcp(otherId);
    try {
      // ── swarm_x (Composio) ─────────────────────────────────────────────────
      const missingKey = await callTool(worker, "swarm_x", {
        method: "GET",
        path: "/tool_router/session",
      });
      expectToolError(missingKey, "swarm_x without a key", "COMPOSIO_API_KEY is required");
      expect(
        missingKey.data.ok === false &&
          missingKey.data.status === 0 &&
          missingKey.data.target === "composio",
        "a missing key is reported as a status-0 failure",
      );
      expectToolError(
        await callTool(worker, "swarm_x", { method: "GET", path: "/x", useOrgKey: true }),
        "swarm_x with the org key but none set",
        "COMPOSIO_ORG_API_KEY is required",
      );
      expect(
        (await callTool(worker, "swarm_x", { method: "TRACE", path: "/x" })).isError,
        "swarm_x rejects an unknown method",
      );
      expect(
        (await callTool(worker, "swarm_x", { method: "GET", path: "/x", baseUrl: "not a url" }))
          .isError,
        "swarm_x rejects an invalid base url",
      );
      expect(
        (await callTool(worker, "swarm_x", { target: "slack", method: "GET", path: "/x" })).isError,
        "swarm_x rejects an unsupported target",
      );

      const composioKey = `ck_${ctx.nonce}_secret`;
      const orgKey = `ok_${ctx.nonce}_secret`;
      const composio = startMockServer((request) => {
        if (request.path === "/missing") return jsonResponse({ error: "not here" }, 404);
        if (request.path === "/plain")
          return new Response("plain text body", { headers: { "Content-Type": "text/plain" } });
        return jsonResponse({ ok: true, path: request.path, echoed: request.json });
      });
      cleanup.add("stop composio mock", async () => composio.stop());
      await track("COMPOSIO_API_KEY", composioKey, true);
      await track("COMPOSIO_ORG_API_KEY", orgKey, true);
      await reloadConfig(ctx);

      const get = expectToolOk(
        await callTool(worker, "swarm_x", {
          method: "GET",
          path: "/tool_router/session",
          query: { limit: 5, active: true, q: "a b" },
          headers: { "X-Trace": ctx.nonce },
          baseUrl: composio.origin,
        }),
        "swarm_x GET",
      );
      expect(
        get.data.ok === true &&
          get.data.status === 200 &&
          get.data.method === "GET" &&
          get.data.target === "composio",
        "swarm_x reports the upstream status",
      );
      expect(
        asRecord(get.data.response).path === "/tool_router/session",
        "swarm_x returns the parsed upstream body",
      );
      const sent = composio.requests[0];
      expect(
        sent?.method === "GET" && sent.path === "/tool_router/session",
        "swarm_x called the upstream path",
      );
      expect(
        sent.query.get("limit") === "5" &&
          sent.query.get("active") === "true" &&
          sent.query.get("q") === "a b",
        "swarm_x appended the query parameters",
      );
      expect(
        sent.headers.get("x-api-key") === composioKey,
        "swarm_x injected the API key server-side",
      );
      expect(sent.headers.get("x-trace") === ctx.nonce, "swarm_x forwarded the extra headers");
      expect(
        !get.text.includes(composioKey) && !JSON.stringify(get.data).includes(composioKey),
        "the API key never reaches the tool result",
      );

      const post = expectToolOk(
        await callTool(worker, "swarm_x", {
          method: "POST",
          path: "/tool_router/session",
          body: { user: ctx.nonce },
          baseUrl: composio.origin,
        }),
        "swarm_x POST",
      );
      expect(
        JSON.stringify(asRecord(post.data.response).echoed) === JSON.stringify({ user: ctx.nonce }),
        "swarm_x sends the JSON body",
      );
      expect(
        composio.requests[1]?.headers.get("content-type")?.includes("application/json"),
        "swarm_x labels a body as JSON",
      );

      const org = expectToolOk(
        await callTool(worker, "swarm_x", {
          method: "GET",
          path: "/org",
          useOrgKey: true,
          baseUrl: composio.origin,
        }),
        "swarm_x with the org key",
      );
      const orgRequest = composio.requests[2];
      expect(
        orgRequest?.headers.get("x-org-api-key") === orgKey &&
          orgRequest.headers.get("x-api-key") === null,
        "useOrgKey swaps the auth header",
      );
      expect(!org.text.includes(orgKey), "the org key never reaches the tool result");

      const raw = expectToolOk(
        await callTool(worker, "swarm_x", {
          method: "GET",
          path: "/plain",
          raw: true,
          baseUrl: composio.origin,
        }),
        "swarm_x raw",
      );
      expect(raw.data.responseText === "plain text body", "raw returns the upstream text");

      const notFound = await callTool(worker, "swarm_x", {
        method: "GET",
        path: "/missing",
        baseUrl: composio.origin,
      });
      expect(
        notFound.isError && notFound.data.status === 404 && notFound.data.ok === false,
        "an upstream error is a tool error carrying the status",
      );
      const unreachable = await callTool(worker, "swarm_x", {
        method: "GET",
        path: "/x",
        baseUrl: "http://127.0.0.1:9",
      });
      expect(
        unreachable.isError && unreachable.data.status === 0,
        "an unreachable upstream is a status-0 tool error",
      );
      expect(!unreachable.text.includes(composioKey), "an upstream failure never leaks the key");

      // ── WhatsApp through Kapso ─────────────────────────────────────────────
      const phoneNumberId = `pn-${ctx.nonce}`;
      const kapsoBefore = ctx.db.query("SELECT 1 FROM kv_entries WHERE namespace = ?", [
        KAPSO_NUMBERS,
      ]).length;
      expectToolError(
        await callTool(worker, "send-whatsapp-message", {
          phoneNumberId,
          to: "34600000001",
          body: "hello",
        }),
        "send-whatsapp-message without a Kapso key",
        "KAPSO_API_KEY is not configured",
      );
      expectToolError(
        await callTool(worker, "reply-whatsapp-message", {
          phoneNumberId,
          to: "34600000001",
          inReplyTo: "wamid.IN",
          body: "hello",
        }),
        "reply-whatsapp-message without a Kapso key",
        "KAPSO_API_KEY is not configured",
      );
      expect(
        (await callTool(worker, "send-whatsapp-message", { phoneNumberId, to: "", body: "x" }))
          .isError,
        "send-whatsapp-message rejects an empty recipient",
      );
      expect(
        (await callTool(worker, "send-whatsapp-message", { phoneNumberId, to: "1" })).isError,
        "send-whatsapp-message rejects a missing body",
      );

      const kapsoKey = `kapso_${ctx.nonce}_secret`;
      const kapso = startMockServer((request) => {
        const message = asRecord(request.json);
        const text = asRecord(message.text);
        if (String(text.body).includes("outside-window")) {
          return jsonResponse(
            { error: { code: 131047, message: "Re-engagement message required" } },
            400,
          );
        }
        if (String(text.body).includes("explode"))
          return jsonResponse({ error: { message: "upstream exploded" } }, 500);
        return jsonResponse({
          messages: [{ id: `wamid.${ctx.nonce}.${request.json ? "1" : "0"}` }],
        });
      });
      cleanup.add("stop kapso mock", async () => kapso.stop());
      await track("KAPSO_API_KEY", kapsoKey, true);
      await track("KAPSO_API_BASE_URL", kapso.origin);

      const sendTool = expectToolOk(
        await callTool(worker, "send-whatsapp-message", {
          phoneNumberId,
          to: "34600000001",
          body: `hello ${ctx.nonce}`,
          previewUrl: true,
        }),
        "send-whatsapp-message",
      );
      expect(
        String(sendTool.data.messageId).startsWith("wamid."),
        "send-whatsapp-message returns the message id",
      );
      const sendRequest = kapso.requests[0];
      const sendBody = asRecord(sendRequest?.json);
      expect(
        sendRequest?.method === "POST" &&
          sendRequest.path === `/meta/whatsapp/v24.0/${phoneNumberId}/messages` &&
          sendRequest.headers.get("x-api-key") === kapsoKey,
        "send hits the Kapso Meta proxy with the API key",
      );
      expect(
        sendBody.messaging_product === "whatsapp" &&
          sendBody.to === "34600000001" &&
          sendBody.type === "text" &&
          asRecord(sendBody.text).body === `hello ${ctx.nonce}` &&
          asRecord(sendBody.text).preview_url === true,
        "send posts a WhatsApp text message",
      );
      expect(sendBody.context === undefined, "a plain send is not a reply");
      expect(!sendTool.text.includes(kapsoKey), "the Kapso key never reaches the tool result");

      expectToolOk(
        await callTool(worker, "reply-whatsapp-message", {
          phoneNumberId,
          to: "34600000001",
          inReplyTo: "wamid.INBOUND",
          body: "answer",
        }),
        "reply-whatsapp-message",
      );
      expect(
        asRecord(asRecord(kapso.requests[1]?.json).context).message_id === "wamid.INBOUND",
        "reply threads to the inbound message id",
      );

      const expired = await callTool(worker, "send-whatsapp-message", {
        phoneNumberId,
        to: "34600000001",
        body: "outside-window",
      });
      expectToolError(expired, "send outside the 24h window", "24h");
      expect(
        expired.data.sessionWindowExpired === true,
        "the tool flags the expired session window",
      );
      const exploded = await callTool(worker, "send-whatsapp-message", {
        phoneNumberId,
        to: "34600000001",
        body: "explode",
      });
      expectToolError(exploded, "send when Kapso fails", "Kapso send failed: upstream exploded");
      expect(
        exploded.data.sessionWindowExpired === false,
        "an ordinary failure is not a window expiry",
      );

      // Registering numbers is lead-only; a refused call changes nothing.
      expectToolError(
        await callTool(worker, "register-kapso-number", { phoneNumberId: `${phoneNumberId}-reg` }),
        "register-kapso-number as a worker",
        "Permission denied",
      );
      expectToolError(
        await callTool(worker, "unregister-kapso-number", {
          phoneNumberId: `${phoneNumberId}-reg`,
        }),
        "unregister-kapso-number as a worker",
        "Permission denied",
      );
      expect(
        ctx.db.query("SELECT 1 FROM kv_entries WHERE namespace = ?", [KAPSO_NUMBERS]).length ===
          kapsoBefore,
        "refused Kapso registrations persist nothing",
      );
      expect(kapso.requests.length === 4, "refused Kapso registrations make no upstream call");

      // ── AgentMail inbox mappings ───────────────────────────────────────────
      const inboxId = `inb_${ctx.nonce}`;
      const inboxEmail = `${inboxId}@agentmail.to`;
      const mappingRow = () =>
        ctx.db.get<{ agentId: string; inboxEmail: string | null }>(
          "SELECT agentId, inboxEmail FROM agentmail_inbox_mappings WHERE inboxId = ?",
          [inboxId],
        );
      const empty = expectToolOk(
        await callTool(worker, "register-agentmail-inbox", { action: "list" }),
        "list inboxes",
      );
      expect(empty.message === "Found 0 mapping(s).", "a new agent has no inbox mappings");
      expectToolError(
        await callTool(worker, "register-agentmail-inbox", { action: "register" }),
        "register without an inbox id",
        "inboxId is required",
      );
      expectToolError(
        await callTool(worker, "register-agentmail-inbox", { action: "unregister", inboxId }),
        "unregister an unknown inbox",
        "No mapping found",
      );
      expect(
        (await callTool(worker, "register-agentmail-inbox", { action: "teleport", inboxId }))
          .isError,
        "an unknown action is rejected",
      );
      const registered = expectToolOk(
        await callTool(worker, "register-agentmail-inbox", {
          action: "register",
          inboxId,
          inboxEmail,
        }),
        "register an inbox",
      );
      const mappings = asRecords({ mappings: registered.data.mappings }, "mappings");
      expect(
        mappings[0]?.inboxId === inboxId &&
          mappings[0]?.agentId === agentId &&
          mappings[0]?.inboxEmail === inboxEmail,
        "register returns the mapping",
      );
      expect(
        mappingRow()?.agentId === agentId && mappingRow()?.inboxEmail === inboxEmail,
        "the mapping is persisted",
      );
      const listed = expectToolOk(
        await callTool(worker, "register-agentmail-inbox", { action: "list" }),
        "list after register",
      );
      expect(
        listed.data.mappings &&
          (listed.data.mappings as unknown[]).length === 1 &&
          listed.text.includes(inboxId),
        "list shows the agent's mapping",
      );
      expect(
        expectToolOk(
          await callTool(other, "register-agentmail-inbox", { action: "list" }),
          "list for another agent",
        ).message === "Found 0 mapping(s).",
        "another agent does not see the mapping",
      );
      expectToolError(
        await callTool(other, "register-agentmail-inbox", { action: "unregister", inboxId }),
        "unregister an inbox owned by another agent",
        "owned by another agent",
      );
      expect(mappingRow()?.agentId === agentId, "a refused unregister keeps the mapping");
      // FINDING: unregister refuses to touch another agent's inbox, but register on the same
      // inbox id silently reassigns it (the insert is an upsert on inboxId), so any agent can
      // take over a mapped inbox without the owner's consent.
      expectToolOk(
        await callTool(other, "register-agentmail-inbox", { action: "register", inboxId }),
        "register an inbox owned by another agent",
      );
      expect(mappingRow()?.agentId === otherId, "register reassigns an inbox to the new caller");
      expectToolOk(
        await callTool(other, "register-agentmail-inbox", { action: "unregister", inboxId }),
        "unregister by the current owner",
      );
      expect(mappingRow() === null, "unregister deletes the mapping");
    } finally {
      await worker.close();
      await other.close();
      await cleanup.run();
      try {
        await reloadConfig(ctx);
      } catch {
        // best effort: the scenario already reported its own failure
      }
    }
  },
};
