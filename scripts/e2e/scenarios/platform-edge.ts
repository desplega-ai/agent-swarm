import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cleanupStack, createUser, hmacSignature, registerAgent, userOf } from "./platform-helpers";

// Routes that sit at the edge of the API and authenticate with something other than the
// swarm key: the liveness ping, the cookie-gated page proxy, the externally exposed script
// endpoints and the signed workflow webhook.

/** A Set-Cookie header reduced to the `name=value` pair a browser sends back. */
function cookiePair(headers: Headers): string {
  const raw = headers.getSetCookie?.()[0] ?? headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

async function scriptId(ctx: ScenarioContext, agentId: string, name: string, source: string) {
  const upsert = await ctx.api("POST", "/api/scripts/upsert", {
    agentId,
    body: { name, description: "e2e", source },
  });
  expectStatus(upsert, [200], `upsert script ${name}`);
  const list = await ctx.api("GET", "/api/scripts", { agentId });
  const found = asRecords(list.json, "scripts").find((s) => s.name === name);
  expect(found, `script ${name} is listed`);
  return String(found.id);
}

export const platformEdge: Scenario = {
  name: "platform-edge",
  order: 646,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    try {
      // ── ping and close ─────────────────────────────────────────────────────
      const agentId = await registerAgent(ctx, "edge");
      const statusOf = async () => {
        const response = await ctx.api("GET", `/api/agents/${agentId}`);
        expectStatus(response, [200], "get agent");
        return String(asRecord(response.json).status);
      };
      expectStatus(await ctx.api("POST", "/ping", { apiKey: null, agentId }), [401], "ping unauth");
      const missing = await ctx.api("POST", "/ping");
      expectStatus(missing, [400], "ping without an agent id");
      expect(
        asRecord(missing.json).error === "Missing X-Agent-ID header",
        "ping names the missing header",
      );
      expectStatus(
        await ctx.api("POST", "/ping", { agentId: "no-such-agent" }),
        [404],
        "ping an unknown agent",
      );
      expectStatus(await ctx.api("POST", "/ping", { agentId }), [204], "ping a registered agent");

      expectStatus(await ctx.api("POST", "/close"), [400], "close without an agent id");
      expectStatus(
        await ctx.api("POST", "/close", { agentId: "no-such-agent" }),
        [404],
        "close an unknown agent",
      );
      expectStatus(await ctx.api("POST", "/close", { agentId }), [204], "close the session");
      expect((await statusOf()) === "offline", "closing a static agent marks it offline");
      expectStatus(await ctx.api("POST", "/ping", { agentId }), [204], "ping after close");
      expect((await statusOf()) === "idle", "a ping brings the agent back");

      // ── realtime browser SDK ───────────────────────────────────────────────
      const sdk = await ctx.api("GET", "/@swarm/realtime.js", { apiKey: null });
      expectStatus(sdk, [200], "realtime sdk");
      expect(
        sdk.headers.get("content-type")?.includes("javascript"),
        "the realtime sdk is javascript",
      );
      expect(sdk.text.length > 1_000, "the realtime sdk is served whole");

      // ── cookie-gated page proxy ────────────────────────────────────────────
      for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"] as const) {
        const denied = await ctx.api(method, "/@swarm/api/pages/whatever", {
          apiKey: null,
          body: method === "GET" || method === "DELETE" ? undefined : {},
        });
        expectStatus(denied, [401], `${method} /@swarm/api without a session`);
        expect(
          asRecord(denied.json).error === "no page session",
          `${method} says there is no page session`,
        );
      }
      expectStatus(
        await ctx.api("GET", "/@swarm/api/pages/whatever", {
          apiKey: null,
          headers: { Cookie: "page_session=garbage" },
        }),
        [401],
        "proxy with a forged legacy cookie",
      );
      // fetch collapses "..", so the unsafe shapes sent are an empty segment and an encoded backslash.
      expectStatus(
        await ctx.api("GET", "/@swarm/api/a//b", { apiKey: null }),
        [404],
        "proxy path with an empty segment",
      );
      expectStatus(
        await ctx.api("GET", "/@swarm/api/a%5Cb", { apiKey: null }),
        [404],
        "proxy path with an encoded backslash",
      );

      const slug = `platform-edge-${ctx.nonce}`;
      const page = await ctx.api("POST", "/api/pages", {
        agentId,
        body: {
          slug,
          title: "Edge page",
          body: "<p>hi</p>",
          contentType: "text/html",
          authMode: "authed",
        },
      });
      expectStatus(page, [201], "create a page");
      const pageId = String(asRecord(page.json).id);
      cleanup.add("delete the page", async () => {
        await ctx.api("DELETE", `/api/pages/${pageId}`, { agentId });
      });
      const launch = await ctx.api("POST", `/api/pages/${pageId}/launch`, { agentId });
      expectStatus(launch, [204], "launch a page session");
      const cookie = cookiePair(launch.headers);
      expect(
        cookie.startsWith(`page_session_${pageId}=`),
        `launch sets the page session cookie, got ${cookie.slice(0, 40)}`,
      );
      const session = {
        apiKey: null,
        headers: { Cookie: cookie, "X-Swarm-Page-Id": pageId },
      } as const;

      const read = await ctx.api("GET", `/@swarm/api/pages/${pageId}`, session);
      expectStatus(read, [200], "proxy GET");
      expect(
        asRecord(read.json).id === pageId && asRecord(read.json).slug === slug,
        "the proxy returns the page",
      );
      expectStatus(
        await ctx.api("GET", `/@swarm/api/pages/${pageId}`, {
          apiKey: null,
          headers: { Cookie: cookie, "X-Swarm-Page-Id": "another-page" },
        }),
        [401],
        "a cookie does not open another page",
      );

      const key = `edge-${ctx.nonce}`;
      const put = await ctx.api("PUT", `/@swarm/api/kv/${key}`, {
        ...session,
        body: { value: "v1" },
      });
      expectStatus(put, [200], "proxy PUT");
      const namespace = String(asRecord(put.json).namespace);
      expect(
        namespace.includes(pageId),
        `the page's kv writes are namespaced to the page: ${namespace}`,
      );
      const stored = await ctx.api("GET", `/api/kv/_/${namespace}/${key}`);
      expect(asRecord(stored.json).value === "v1", "the proxied write is visible through the API");
      expect(
        asRecord((await ctx.api("GET", `/@swarm/api/kv/${key}`, session)).json).value === "v1",
        "proxy GET reads it back",
      );
      const incr = await ctx.api("POST", `/@swarm/api/kv/${key}-count/incr`, {
        ...session,
        body: {},
      });
      expectStatus(incr, [200], "proxy POST");
      expect(asRecord(incr.json).value === 1, "the proxied increment starts at 1");
      const user = await createUser(ctx, "edge-user");
      const patch = await ctx.api("PATCH", `/@swarm/api/users/${user.id}`, {
        ...session,
        body: { name: `Patched ${ctx.nonce}` },
      });
      expectStatus(patch, [200], "proxy PATCH");
      expect(
        userOf(patch.json).name === `Patched ${ctx.nonce}`,
        "an operator-launched session can patch through the proxy",
      );
      const removed = await ctx.api("DELETE", `/@swarm/api/kv/${key}`, session);
      expectStatus(removed, [204], "proxy DELETE");
      expectStatus(
        await ctx.api("GET", `/api/kv/_/${namespace}/${key}`),
        [404],
        "the proxied delete removed the row",
      );

      // ── externally exposed script endpoints ────────────────────────────────
      const echo = await scriptId(
        ctx,
        agentId,
        `edge-echo-${ctx.nonce}`,
        "export default async function main(args: unknown) { return { echo: args }; }",
      );
      const boom = await scriptId(
        ctx,
        agentId,
        `edge-boom-${ctx.nonce}`,
        'export default async function main() { throw new Error("boom"); }',
      );
      const endpointOf = async (id: string, body: Record<string, unknown>) => {
        const response = await ctx.api("POST", `/api/scripts/${id}/apis`, { agentId, body });
        expectStatus(response, [201], "expose a script");
        const endpoint = asRecord(response.json);
        cleanup.add(`delete endpoint ${String(endpoint.id)}`, async () => {
          await ctx.api("DELETE", `/api/scripts/${id}/apis/${String(endpoint.id)}`, { agentId });
        });
        return endpoint;
      };
      const bearer = await endpointOf(echo, { authMode: "bearer", label: "e2e bearer" });
      const token = String(bearer.token);
      expect(token.startsWith("xsk_"), "a bearer endpoint returns its token once");
      const call = (
        endpointId: string,
        init: {
          token?: string | null;
          body?: unknown;
          raw?: string;
          headers?: Record<string, string>;
        },
      ) =>
        ctx.api("POST", `/api/x/script/${endpointId}`, {
          apiKey: init.token ?? null,
          ...(init.raw !== undefined
            ? {
                rawBody: init.raw,
                headers: { "Content-Type": "application/json", ...init.headers },
              }
            : { body: init.body, headers: init.headers }),
        });

      expectStatus(await call("no-such-endpoint", { body: {} }), [404], "call an unknown endpoint");
      const noToken = await call(String(bearer.id), { body: { a: 1 } });
      expectStatus(noToken, [401], "call a bearer endpoint without a token");
      expect(
        asRecord(asRecord(noToken.json).error).type === "unauthorized",
        "the 401 uses the error envelope",
      );
      expectStatus(
        await call(String(bearer.id), { token: `${token}x`, body: {} }),
        [401],
        "call with a wrong token",
      );
      // The swarm API key is not an endpoint credential.
      expectStatus(
        await call(String(bearer.id), { token: ctx.apiKey, body: {} }),
        [401],
        "call with the swarm key",
      );

      const ok = await call(String(bearer.id), {
        token,
        body: { a: 1 },
        headers: { "X-Swarm-Timeout-Ms": "20000" },
      });
      expectStatus(ok, [200], "call a bearer endpoint");
      const result = asRecord(ok.json);
      expect(
        result.ok === true &&
          result.error === null &&
          JSON.stringify(result.result) === JSON.stringify({ echo: { a: 1 } }) &&
          typeof result.durationMs === "number",
        `the endpoint answers the result envelope: ${ok.text}`,
      );
      const badBody = await call(String(bearer.id), { token, raw: "{not json" });
      expectStatus(badBody, [200], "call with an invalid json body");
      expect(
        asRecord(asRecord(badBody.json).error).type === "invalid_json" &&
          asRecord(badBody.json).ok === false,
        "an invalid body is reported in the envelope",
      );
      const stats = await ctx.api("GET", `/api/scripts/${echo}/apis`, { agentId });
      const listed = asRecords(stats.json, "apis").find((a) => a.id === bearer.id);
      expect(
        Number(listed?.callCount) >= 1 && typeof listed?.lastUsedAt === "string",
        "calls are counted on the endpoint",
      );

      const open = await endpointOf(echo, { authMode: "none", label: "e2e open" });
      const openCall = await call(String(open.id), { body: { open: true } });
      expectStatus(openCall, [200], "call an endpoint without auth");
      expect(asRecord(openCall.json).ok === true, "an open endpoint needs no token");

      const failing = await endpointOf(boom, { authMode: "none" });
      const failed = await call(String(failing.id), { body: {} });
      expectStatus(failed, [200], "call a failing script");
      expect(
        asRecord(failed.json).ok === false &&
          asRecord(failed.json).result === null &&
          asRecord(asRecord(failed.json).error).type === "runtime_error" &&
          String(asRecord(asRecord(failed.json).error).message).includes("boom"),
        `a script failure is a 200 with a runtime_error envelope: ${failed.text}`,
      );

      const disabled = await ctx.api("PATCH", `/api/scripts/${echo}/apis/${String(open.id)}`, {
        agentId,
        body: { enabled: false },
      });
      expectStatus(disabled, [200], "disable an endpoint");
      expectStatus(await call(String(open.id), { body: {} }), [404], "call a disabled endpoint");

      // ── signed workflow webhook ────────────────────────────────────────────
      const secret = `wh-${ctx.nonce}`;
      const workflow = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `edge-hook-${ctx.nonce}`,
          definition: {
            nodes: [{ id: "a", type: "script", config: { runtime: "bash", script: "echo hook" } }],
          },
          triggers: [{ type: "webhook", hmacSecret: secret }],
        },
      });
      expectStatus(workflow, [201], "create a workflow with a webhook trigger");
      const workflowId = String(asRecord(workflow.json).id);
      const plain = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `edge-nohook-${ctx.nonce}`,
          definition: {
            nodes: [{ id: "a", type: "script", config: { runtime: "bash", script: "echo none" } }],
          },
        },
      });
      expectStatus(plain, [201], "create a workflow without a webhook trigger");
      const hook = (id: string, body: string, headers: Record<string, string> = {}) =>
        ctx.api("POST", `/api/webhooks/${id}`, { apiKey: null, rawBody: body, headers });
      const payload = JSON.stringify({ hello: ctx.nonce });
      expectStatus(
        await hook("no-such-workflow", payload),
        [404],
        "webhook for an unknown workflow",
      );
      const unsigned = await hook(workflowId, payload);
      expectStatus(unsigned, [401], "webhook without a signature");
      expect(
        asRecord(unsigned.json).error === "Missing signature",
        "the 401 says the signature is missing",
      );
      const wrong = await hook(workflowId, payload, { "X-Hub-Signature-256": "sha256=deadbeef" });
      expectStatus(wrong, [401], "webhook with a wrong signature");
      expect(
        asRecord(wrong.json).error === "Invalid signature",
        "the 401 says the signature is invalid",
      );
      expectStatus(
        await hook(String(asRecord(plain.json).id), payload),
        [404],
        "webhook for a workflow without a webhook trigger",
      );
      const accepted = await hook(workflowId, payload, {
        "X-Hub-Signature-256": hmacSignature(secret, payload),
      });
      expectStatus(accepted, [201], "signed webhook");
      const runId = String(asRecord(accepted.json).runId);
      const run = await ctx.api("GET", `/api/workflow-runs/${runId}`);
      expectStatus(run, [200], "read the webhook run");
      expect(
        asRecord(asRecord(run.json).run).workflowId === workflowId,
        "the webhook started a run of that workflow",
      );
      const settled = await pollUntil(async () => {
        const current = await ctx.api("GET", `/api/workflow-runs/${runId}`);
        return ["completed", "failed", "cancelled", "skipped"].includes(
          String(asRecord(asRecord(current.json).run).status),
        );
      }, 30_000);
      expect(settled, "the webhook run reached a terminal status");
    } finally {
      await cleanup.run();
    }
  },
};
