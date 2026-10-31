import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  cleanupStack,
  deleteConfig,
  expectToolError,
  expectToolOk,
  fakeJwt,
  jsonResponse,
  type MockRequest,
  putConfig,
  registerAgent,
  reloadConfig,
  startMockServer,
} from "./platform-helpers";

// Worker-callable tools that reach third-party services: the Composio router (swarm_x),
// WhatsApp through Kapso, and AgentMail inbox mappings. The third parties are loopback
// stand-ins configured through swarm_config, so the requests the swarm makes are asserted
// as well as the tool results. The lead-only Kapso number registration is in
// platform-lead-tools. The Codex ChatGPT device login runs against the same kind of
// stand-in, pointed at through CODEX_OAUTH_DEVICE_BASE_URL.

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
      // Register refuses the same takeover, and a refused call changes nothing.
      expectToolError(
        await callTool(other, "register-agentmail-inbox", {
          action: "register",
          inboxId,
          inboxEmail: `taken-${inboxEmail}`,
        }),
        "register an inbox owned by another agent",
        "owned by another agent",
      );
      expect(
        mappingRow()?.agentId === agentId && mappingRow()?.inboxEmail === inboxEmail,
        "a refused register keeps the owner and the email",
      );
      expect(
        expectToolOk(
          await callTool(other, "register-agentmail-inbox", { action: "list" }),
          "list after the refused register",
        ).message === "Found 0 mapping(s).",
        "a refused register adds no mapping for the caller",
      );
      // The owner registering again is a success and keeps the mapping.
      const again = expectToolOk(
        await callTool(worker, "register-agentmail-inbox", {
          action: "register",
          inboxId,
          inboxEmail,
        }),
        "register an inbox the caller already owns",
      );
      expect(
        asRecords({ mappings: again.data.mappings }, "mappings")[0]?.agentId === agentId &&
          mappingRow()?.agentId === agentId,
        "an owner re-register keeps the mapping",
      );
      expectToolOk(
        await callTool(worker, "register-agentmail-inbox", { action: "unregister", inboxId }),
        "unregister by the owner",
      );
      expect(mappingRow() === null, "unregister deletes the mapping");
      // A freed inbox can be registered by another agent.
      expectToolOk(
        await callTool(other, "register-agentmail-inbox", { action: "register", inboxId }),
        "register a freed inbox",
      );
      expect(mappingRow()?.agentId === otherId, "a freed inbox goes to the new registrant");
      expectToolOk(
        await callTool(other, "register-agentmail-inbox", { action: "unregister", inboxId }),
        "unregister by the new owner",
      );
      expect(mappingRow() === null, "the second unregister deletes the mapping");
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

type DeviceStub = ReturnType<typeof startDeviceServer>;

/**
 * A loopback stand-in for the ChatGPT device authorization endpoints and the token endpoint
 * that ends an approved login. `state` scripts what each endpoint answers.
 */
function startDeviceServer(port = 0) {
  const state = {
    /** Status of the user-code endpoint. 200 issues a code. */
    usercode: 200,
    /** Seconds the stand-in asks the client to wait between polls. */
    interval: 1,
    /**
     * Status of the token-poll endpoint. 403 and 404 mean the user has not approved yet. 200
     * means the user approved and the endpoint returns the authorization code.
     */
    token: 403,
    /** Status of the code-for-token endpoint. 200 returns `accessToken` and `refreshToken`. */
    exchange: 200,
    accessToken: "",
    refreshToken: "",
    issued: 0,
  };
  const server = startMockServer((request: MockRequest) => {
    if (request.path === "/api/accounts/deviceauth/usercode") {
      if (state.usercode !== 200) return new Response("no", { status: state.usercode });
      state.issued += 1;
      return jsonResponse({
        device_auth_id: `device-auth-${state.issued}`,
        user_code: `USER-${state.issued}`,
        interval: state.interval,
      });
    }
    if (request.path === "/api/accounts/deviceauth/token") {
      if (state.token === 200) {
        return jsonResponse({
          authorization_code: "device-code",
          code_verifier: "device-verifier",
        });
      }
      return new Response("pending", { status: state.token });
    }
    if (request.path === "/oauth/token") {
      if (state.exchange !== 200) return new Response("denied", { status: state.exchange });
      return jsonResponse({
        access_token: state.accessToken,
        refresh_token: state.refreshToken,
        expires_in: 3600,
      });
    }
    return new Response("not found", { status: 404 });
  }, port);
  return Object.assign(server, { state });
}

function deviceRequests(stub: DeviceStub, path: string): MockRequest[] {
  return stub.requests.filter((r) => r.path === `/api/accounts/deviceauth/${path}`);
}

// The ChatGPT device login, run against a loopback stand-in. CODEX_OAUTH_DEVICE_BASE_URL is an
// env-only, loopback-only key: the runner fixes a free port at boot (ctx.sutEnv) and the stub
// binds there, so the login, including the token endpoint an approved login ends at, reaches
// the stand-in. A config write of that key must be refused. Covered: the start outcomes, the
// pending, failed and approved poll outcomes, and the stored account.
export const platformCodexDeviceLogin: Scenario = {
  name: "platform-codex-device-login",
  order: 648,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const bootBase = ctx.sutEnv.CODEX_OAUTH_DEVICE_BASE_URL;
    expect(
      typeof bootBase === "string" && bootBase.startsWith("http://127.0.0.1:"),
      "the runner booted the SUT with a loopback CODEX_OAUTH_DEVICE_BASE_URL",
    );
    const stub = startDeviceServer(Number(new URL(bootBase).port));
    cleanup.add("stop the device stand-in", async () => stub.stop());
    try {
      expect(stub.origin === bootBase, `the stub binds the boot port: ${stub.origin}`);
      // The key is deployment-env only: a config writer cannot redirect the login.
      const reservedWrite = await ctx.api("PUT", "/api/config", {
        body: {
          scope: "global",
          key: "CODEX_OAUTH_DEVICE_BASE_URL",
          value: "https://evil.example",
        },
      });
      expectStatus(reservedWrite, [400], "config write of CODEX_OAUTH_DEVICE_BASE_URL is refused");
      expect(
        String(asRecord(reservedWrite.json).error).toLowerCase().includes("reserved"),
        `the refusal names the reserved key: ${reservedWrite.text.slice(0, 200)}`,
      );

      // ── start ──────────────────────────────────────────────────────────────
      stub.state.usercode = 404;
      const notEnabled = await ctx.api("POST", "/api/codex-oauth/device", { body: {} });
      expectStatus(notEnabled, [409], "start when device login is not enabled");
      expect(
        String(asRecord(notEnabled.json).error).includes("not enabled"),
        "a 404 from the user-code endpoint reads as not enabled",
      );
      stub.state.usercode = 500;
      const upstreamDown = await ctx.api("POST", "/api/codex-oauth/device", { body: {} });
      expectStatus(upstreamDown, [502], "start when the user-code endpoint fails");
      expect(
        String(asRecord(upstreamDown.json).error) === "Failed to start Codex device login",
        "an upstream failure is a 502 with a plain message",
      );

      stub.state.usercode = 200;
      const started = await ctx.api("POST", "/api/codex-oauth/device", { body: {} });
      expectStatus(started, [200], "start a device login");
      const flow = asRecord(started.json);
      const flowId = String(flow.flowId);
      expect(
        /^[0-9a-f-]{36}$/.test(flowId) &&
          flow.userCode === "USER-1" &&
          flow.intervalSeconds === 1 &&
          flow.verificationUrl === `${stub.origin}/codex/device` &&
          Math.abs(new Date(String(flow.expiresAt)).getTime() - Date.now() - 15 * 60_000) < 60_000,
        `start returns the flow id, user code, interval, verification url and a 15 minute expiry: ${started.text}`,
      );
      expect(!started.text.includes("device-auth-1"), "start never exposes the device auth id");
      const asked = deviceRequests(stub, "usercode").filter((r) => r.json !== null);
      const lastAsk = asked[asked.length - 1];
      expect(
        asRecord(lastAsk?.json).client_id !== undefined &&
          lastAsk?.headers.get("originator") === "agent-swarm",
        "the user-code request names the client and originator",
      );
      const stored = ctx.db.get<{ state: string }>(
        "SELECT state FROM codex_oauth_device_flows WHERE flow_id = ?",
        [flowId],
      );
      expect(
        stored !== null &&
          !stored.state.includes("device-auth-1") &&
          !stored.state.includes("USER-1"),
        "the flow state is stored encrypted",
      );

      // ── poll ───────────────────────────────────────────────────────────────
      const first = await ctx.api("POST", `/api/codex-oauth/device/${flowId}/poll`, { body: {} });
      expectStatus(first, [200], "poll before approval");
      expect(asRecord(first.json).status === "pending", "an unapproved login is pending");
      expect(deviceRequests(stub, "token").length === 1, "the first poll asks the endpoint");
      expect(
        asRecord(deviceRequests(stub, "token")[0]?.json).device_auth_id === "device-auth-1" &&
          asRecord(deviceRequests(stub, "token")[0]?.json).user_code === "USER-1",
        "the poll sends the device auth id and the user code",
      );
      const early = await ctx.api("POST", `/api/codex-oauth/device/${flowId}/poll`, { body: {} });
      expect(asRecord(early.json).status === "pending", "a poll inside the interval is pending");
      expect(
        deviceRequests(stub, "token").length === 1,
        "a poll inside the interval does not reach the endpoint",
      );

      // A fractional interval lets a second flow poll again without a long wait.
      stub.state.interval = 0.05;
      const quick = asRecord((await ctx.api("POST", "/api/codex-oauth/device", { body: {} })).json);
      const quickId = String(quick.flowId);
      expect(quick.intervalSeconds === 0.05, "start keeps a fractional poll interval");
      const quickPending = await ctx.api("POST", `/api/codex-oauth/device/${quickId}/poll`, {
        body: {},
      });
      expect(asRecord(quickPending.json).status === "pending", "the second flow starts pending");
      await Bun.sleep(150);
      stub.state.token = 500;
      const failed = await ctx.api("POST", `/api/codex-oauth/device/${quickId}/poll`, {
        body: {},
      });
      expectStatus(failed, [200], "poll when the token endpoint fails");
      expect(
        asRecord(failed.json).status === "failed" &&
          asRecord(failed.json).error === "Device authorization failed (HTTP 500)",
        `a token endpoint failure ends the login: ${failed.text}`,
      );
      const before = deviceRequests(stub, "token").length;
      const again = await ctx.api("POST", `/api/codex-oauth/device/${quickId}/poll`, { body: {} });
      expect(
        asRecord(again.json).status === "failed" && deviceRequests(stub, "token").length === before,
        "a failed login stays failed without another upstream call",
      );

      // ── approved ───────────────────────────────────────────────────────────
      const accountId = `acct-${ctx.nonce}`;
      const userId = `user-${ctx.nonce}`;
      const email = `device-${ctx.nonce}@example.com`;
      stub.state.accessToken = fakeJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: accountId,
          chatgpt_plan_type: "plus",
          chatgpt_user_id: userId,
        },
        "https://api.openai.com/profile": { email },
      });
      stub.state.refreshToken = `refresh-${ctx.nonce}`;
      stub.state.token = 200;
      const listAccounts = async () =>
        asRecords((await ctx.api("GET", "/api/codex-oauth/accounts")).json, "accounts");
      const accountsBefore = (await listAccounts()).length;
      const exchanges = () => stub.requests.filter((r) => r.path === "/oauth/token");

      // The user approved, but the code-for-token call is refused: no account is stored.
      stub.state.exchange = 400;
      const refusedId = String(
        asRecord((await ctx.api("POST", "/api/codex-oauth/device", { body: {} })).json).flowId,
      );
      const refused = await ctx.api("POST", `/api/codex-oauth/device/${refusedId}/poll`, {
        body: {},
      });
      expectStatus(refused, [200], "poll when the code exchange is refused");
      expect(
        asRecord(refused.json).status === "failed" &&
          asRecord(refused.json).error === "Token exchange failed" &&
          exchanges().length === 1,
        `a refused code exchange ends the login: ${refused.text}`,
      );
      expect(
        (await listAccounts()).length === accountsBefore,
        "a refused code exchange stores no account",
      );

      // The user approved and the exchange succeeds: the account is stored in the first free slot.
      stub.state.exchange = 200;
      const approvedId = String(
        asRecord((await ctx.api("POST", "/api/codex-oauth/device", { body: {} })).json).flowId,
      );
      const approved = await ctx.api("POST", `/api/codex-oauth/device/${approvedId}/poll`, {
        body: {},
      });
      expectStatus(approved, [200], "poll after approval");
      const slot = asRecord(approved.json).slot;
      expect(
        asRecord(approved.json).status === "complete" &&
          typeof slot === "number" &&
          !approved.text.includes(stub.state.refreshToken) &&
          !approved.text.includes(stub.state.accessToken),
        `an approved login completes with a slot and no token: ${approved.text}`,
      );
      cleanup.add("delete the signed-in account", async () => {
        await ctx.api("DELETE", `/api/codex-oauth/accounts/${String(slot)}`);
      });
      const exchange = exchanges()[1];
      expect(
        exchanges().length === 2 &&
          exchange?.method === "POST" &&
          exchange.form.get("grant_type") === "authorization_code" &&
          exchange.form.get("code") === "device-code" &&
          exchange.form.get("code_verifier") === "device-verifier" &&
          exchange.form.get("redirect_uri") === `${stub.origin}/deviceauth/callback` &&
          Boolean(exchange.form.get("client_id")),
        "the code exchange sends the approved code, its verifier and the device redirect uri",
      );

      const configKey = `codex_oauth_${String(slot)}`;
      const account = (await listAccounts()).find((a) => a.slot === slot);
      expect(account, "the new account is listed");
      expect(
        account.configKey === configKey &&
          account.legacy === false &&
          account.plan === "plus" &&
          account.email === email &&
          account.suffix === userId.slice(-5) &&
          account.status === "ok",
        `the account is listed as signed in with the plan and email from the token: ${JSON.stringify(account)}`,
      );
      expect((await listAccounts()).length === accountsBefore + 1, "exactly one account was added");
      expect(
        !JSON.stringify(account).includes(stub.state.refreshToken),
        "the list never carries the refresh token",
      );
      const credentialRow = ctx.db.get<{ value: string; isSecret: number; encrypted: number }>(
        "SELECT value, isSecret, encrypted FROM swarm_config WHERE scope = 'global' AND key = ?",
        [configKey],
      );
      expect(
        credentialRow !== null &&
          credentialRow.isSecret === 1 &&
          credentialRow.encrypted === 1 &&
          !credentialRow.value.includes(stub.state.refreshToken),
        "the credentials are stored as an encrypted secret",
      );
      const repeat = await ctx.api("POST", `/api/codex-oauth/device/${approvedId}/poll`, {
        body: {},
      });
      expect(
        asRecord(repeat.json).status === "complete" &&
          asRecord(repeat.json).slot === slot &&
          exchanges().length === 2,
        "polling a completed login repeats the result without another upstream call",
      );

      expectStatus(
        await ctx.api("DELETE", `/api/codex-oauth/accounts/${String(slot)}`),
        [200],
        "delete the signed-in account",
      );
      expect(
        !(await listAccounts()).some((a) => a.slot === slot),
        "the deleted account is gone from the list",
      );
    } finally {
      await cleanup.run();
    }
  },
};
