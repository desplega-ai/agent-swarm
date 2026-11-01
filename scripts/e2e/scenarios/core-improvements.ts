import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callToolErr, callToolOk, registerWorker } from "./workflow-helpers";

type Captured = { path: string; body: Record<string, unknown> };

/** A stand-in for the telemetry proxy's `/v1/improvements`. */
function startProxy() {
  const received: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      received.push({
        path: url.pathname,
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json({ status: "accepted", id: crypto.randomUUID() }, { status: 202 });
    },
  });
  return { server, received, origin: `http://127.0.0.1:${server.port}` };
}

async function setGlobal(ctx: ScenarioContext, key: string, value: string): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", scopeId: null, key, value, isSecret: false },
  });
  expectStatus(response, [200], `set ${key}`);
  return String(asRecord(response.json).id);
}

function improvementOf(json: unknown): Record<string, unknown> {
  return asRecord(asRecord(json).improvement);
}

/**
 * Improvements: an agent drafts (MCP and REST), an agent approve is refused,
 * the operator approves and the proxy receives exactly the three fields, the
 * drafting agent discards its own draft, and the kill switch refuses writes.
 */
export const coreImprovements: Scenario = {
  name: "core-improvements",
  order: 266,
  async run(ctx) {
    const proxy = startProxy();
    // A function, so an earlier assertion does not narrow the count for later reads.
    const sentCount = () => proxy.received.length;
    const configIds: string[] = [];
    const workerId = await registerWorker(ctx, "improvements");
    const connection = await ctx.connectMcp(workerId);
    try {
      configIds.push(await setGlobal(ctx, "feedback_endpoint", `${proxy.origin}/v1/feedback`));
      configIds.push(await setGlobal(ctx, "IMPROVEMENTS_ENABLED", "true"));

      // MCP: the tool drafts only.
      const drafted = await callToolOk(connection, "submit-improvement", {
        text: `Improve search ${ctx.nonce}`,
      });
      const draftId = asString(asRecord(drafted.structured).id, "drafted id");
      expect(sentCount() === 0, "the tool sent something to the proxy");

      // REST: an agent's sendNow still drafts.
      let response = await ctx.api("POST", "/api/improvements", {
        agentId: workerId,
        body: { text: `Faster boot ${ctx.nonce}`, sendNow: true },
      });
      expectStatus(response, [201], "agent drafts over REST");
      const restDraft = improvementOf(response.json);
      expect(restDraft.status === "pending_approval", `agent sendNow ${response.text}`);
      const restId = asString(restDraft.id, "rest draft id");

      // An agent cannot approve.
      response = await ctx.api("POST", `/api/improvements/${draftId}/approve`, {
        agentId: workerId,
        body: {},
      });
      expectStatus(response, [403], "agent approve is refused");
      expect(sentCount() === 0, "an agent approve reached the proxy");

      // The list shows both drafts with leak hints.
      response = await ctx.api("GET", "/api/improvements");
      expectStatus(response, [200], "list improvements");
      const list = asRecord(response.json);
      expect(list.enabled === true, `list ${response.text}`);
      const ids = asRecords(response.json, "improvements").map((row) => row.id);
      expect(ids.includes(draftId) && ids.includes(restId), "list lacks the drafts");

      // The operator approves; the proxy receives exactly three fields.
      response = await ctx.api("POST", `/api/improvements/${draftId}/approve`, {
        body: { email: `person-${ctx.nonce}@example.com` },
      });
      expectStatus(response, [200], "operator approves");
      const sent = improvementOf(response.json);
      expect(sent.status === "sent" && sent.approvedBy === "operator", `approve ${response.text}`);
      const relayed = proxy.received.at(-1);
      expect(relayed?.path === "/v1/improvements", `proxy path ${relayed?.path}`);
      const keys = Object.keys(relayed?.body ?? {});
      expect(
        keys.every((key) => ["install_id", "text", "email"].includes(key)) &&
          relayed?.body.text === `Improve search ${ctx.nonce}`,
        `proxy body ${JSON.stringify(relayed?.body)}`,
      );
      expectStatus(
        await ctx.api("POST", `/api/improvements/${draftId}/approve`, { body: {} }),
        [409],
        "double approve",
      );

      // The drafting agent discards its own draft.
      response = await ctx.api("POST", `/api/improvements/${restId}/discard`, {
        agentId: workerId,
      });
      expectStatus(response, [200], "agent discards its own draft");
      expect(improvementOf(response.json).status === "discarded", response.text);

      // Kill switch.
      configIds.push(await setGlobal(ctx, "IMPROVEMENTS_ENABLED", "false"));
      await callToolErr(connection, "submit-improvement", { text: "off" });
      response = await ctx.api("POST", "/api/improvements", { body: { text: "off" } });
      expectStatus(response, [409], "create with the switch off");
      expect(asRecord(response.json).code === "improvements_disabled", response.text);
      response = await ctx.api("GET", "/api/improvements");
      expect(asRecord(response.json).enabled === false, "list reports the switch off");
      expect(sentCount() === 1, "the proxy got more than the one approved send");
    } finally {
      await connection.close();
      proxy.server.stop(true);
      for (const id of new Set(configIds)) await ctx.api("DELETE", `/api/config/${id}`);
    }
  },
};
