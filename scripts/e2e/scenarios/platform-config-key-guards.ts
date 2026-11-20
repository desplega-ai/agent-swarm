import { existsSync, rmSync } from "node:fs";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { cleanupStack, putConfig, registerAgent, reloadConfig } from "./platform-helpers";

/** A stand-in for the telemetry proxy's `/v1/improvements`. */
function startProxy() {
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      received.push(new URL(request.url).pathname);
      return Response.json({ status: "accepted", id: crypto.randomUUID() }, { status: 202 });
    },
  });
  return { server, received, origin: `http://127.0.0.1:${server.port}` };
}

/**
 * Guards on swarm_config writes: `envPath` is stored but never written to disk,
 * keys that cannot be env names are refused, `OPENCODE_SDK_PATH` is deployment
 * env only, process-control keys stay out of the API process env on reload, API
 * self-calls ignore a stored `MCP_BASE_URL`, and an improvement send goes
 * through the outbound URL guard.
 */
export const platformConfigKeyGuards: Scenario = {
  name: "platform-config-key-guards",
  order: 627,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const prefix = `E2E_KEYGUARD_${ctx.nonce.toUpperCase()}`;
    const track = async (input: Parameters<typeof putConfig>[1]) => {
      const row = await putConfig(ctx, input);
      const id = String(row.id);
      cleanup.add(`delete ${input.key}`, async () => {
        await ctx.api("DELETE", `/api/config/${id}`);
      });
      return row;
    };
    const proxy = startProxy();
    let restarted = false;
    try {
      // ── envPath is metadata only ───────────────────────────────────────────
      const envPath = `/tmp/e2e-keyguard-${ctx.nonce}.env`;
      cleanup.add("remove env file", async () => rmSync(envPath, { force: true }));
      const fileKey = `${prefix}_FILE`;
      let response = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: fileKey, value: "stored", envPath },
      });
      expectStatus(response, [200], "PUT with envPath");
      const fileRow = asRecord(response.json);
      cleanup.add(`delete ${fileKey}`, async () => {
        await ctx.api("DELETE", `/api/config/${String(fileRow.id)}`);
      });
      expect(fileRow.value === "stored", `stored value ${response.text}`);
      expect(fileRow.envPath === envPath, `envPath kept on the row ${response.text}`);
      expect(!existsSync(envPath), "a config write created a file at envPath");

      // ── keys that cannot be env names ──────────────────────────────────────
      for (const key of [`${prefix}_A=B`, `${prefix}_A\nB`, `${prefix}_A\rB`]) {
        response = await ctx.api("PUT", "/api/config", {
          body: { scope: "global", key, value: "x" },
        });
        expectStatus(response, [400], `PUT key ${JSON.stringify(key)}`);
        expect(response.text.includes("Invalid config key"), `key error ${response.text}`);
      }

      // ── OPENCODE_SDK_PATH is deployment env only ───────────────────────────
      for (const scope of ["global", "agent"] as const) {
        response = await ctx.api("PUT", "/api/config", {
          body: {
            scope,
            scopeId: scope === "agent" ? crypto.randomUUID() : null,
            key: "OPENCODE_SDK_PATH",
            value: "/tmp/sdk.js",
          },
        });
        expectStatus(response, [400], `PUT ${scope} OPENCODE_SDK_PATH`);
        expect(response.text.includes("reserved"), `reserved error ${response.text}`);
      }

      // ── process-control keys stay out of the API env ───────────────────────
      const plainKey = `${prefix}_PLAIN`;
      const loaderKey = `LD_${prefix}`;
      await track({ key: plainKey, value: "plain" });
      await track({ key: "NODE_PATH", value: `/nonexistent-${ctx.nonce}` });
      await track({ key: loaderKey, value: "unused" });
      await track({ key: "CLAUDE_BINARY", value: `/nonexistent-${ctx.nonce}/claude` });
      const reloaded = await reloadConfig(ctx);
      const updated = Array.isArray(reloaded.keysUpdated) ? reloaded.keysUpdated : [];
      expect(updated.includes(plainKey), `plain key not injected: ${JSON.stringify(updated)}`);
      expect(!updated.includes("NODE_PATH"), "NODE_PATH reached the API process env");
      expect(!updated.includes(loaderKey), `${loaderKey} reached the API process env`);
      expect(!updated.includes("CLAUDE_BINARY"), "CLAUDE_BINARY reached the API process env");

      // ── API self-calls ignore a stored MCP_BASE_URL ────────────────────────
      // The row is injected into the API env, but calls the API makes to itself
      // with its own key (keep-warm sweep, script tool proxy, memory_rate) stay on loopback.
      const redirect = startProxy();
      cleanup.add("stop redirect listener", async () => redirect.server.stop(true));
      const baseRow = await track({ key: "MCP_BASE_URL", value: redirect.origin });
      const injected = await reloadConfig(ctx);
      expect(
        Array.isArray(injected.keysUpdated) && injected.keysUpdated.includes("MCP_BASE_URL"),
        `MCP_BASE_URL not injected: ${JSON.stringify(injected.keysUpdated)}`,
      );
      response = await ctx.api("POST", "/api/oauth/keep-warm/codex");
      expectStatus(response, [200], "keep-warm with a stored MCP_BASE_URL");
      const agentId = await registerAgent(ctx, "self-call");
      const mcp = await ctx.connectMcp(agentId);
      try {
        await mcp.callTool("script-search", { query: ctx.nonce });
      } finally {
        await mcp.close();
      }
      // memory_rate posts the rating back to this API with its own key.
      const taskMcp = await ctx.connectMcp(agentId, {
        headers: { "X-Source-Task-ID": crypto.randomUUID() },
      });
      try {
        await taskMcp.callTool("memory_rate", { id: crypto.randomUUID(), useful: true });
      } finally {
        await taskMcp.close();
      }
      expect(
        redirect.received.length === 0,
        `API self-calls reached a stored MCP_BASE_URL: ${JSON.stringify(redirect.received)}`,
      );
      // Drop the row now so the restarts below boot with the deployment value.
      await ctx.api("DELETE", `/api/config/${String(baseRow.id)}`);
      await reloadConfig(ctx);

      // ── improvement sends use the outbound URL guard ───────────────────────
      // Outside development and test, a loopback http endpoint is refused.
      await ctx.restartSut({ env: { NODE_ENV: "production" } });
      restarted = true;
      await track({ key: "feedback_endpoint", value: `${proxy.origin}/v1/feedback` });
      await track({ key: "IMPROVEMENTS_ENABLED", value: "true" });
      response = await ctx.api("POST", "/api/improvements", {
        body: {
          text: `Guarded send ${ctx.nonce}`,
          sendNow: true,
          email: `person-${ctx.nonce}@example.com`,
        },
      });
      expectStatus(response, [200], "operator sendNow");
      const refused = asRecord(asRecord(response.json).improvement);
      const improvementId = asString(refused.id, "improvement id");
      expect(refused.status === "failed", `guarded send status ${response.text}`);
      expect(
        String(refused.proxyError ?? "")
          .toLowerCase()
          .includes("refus"),
        `guarded send error ${response.text}`,
      );
      expect(proxy.received.length === 0, "the guarded send reached the loopback endpoint");

      // The test env allows loopback, so the same failed row now sends.
      await ctx.restartSut();
      restarted = false;
      response = await ctx.api("POST", `/api/improvements/${improvementId}/approve`, {
        body: { email: `person-${ctx.nonce}@example.com` },
      });
      expectStatus(response, [200], "approve the failed send");
      const sent = asRecord(asRecord(response.json).improvement);
      expect(sent.status === "sent", `retry status ${response.text}`);
      // A fresh read: the earlier length assertion narrowed the array type.
      const received: string[] = [...proxy.received];
      expect(
        received.length === 1 && received[0] === "/v1/improvements",
        `proxy got ${JSON.stringify(received)}`,
      );
    } finally {
      if (restarted) await ctx.restartSut();
      await cleanup.run();
      proxy.server.stop(true);
    }
  },
};
