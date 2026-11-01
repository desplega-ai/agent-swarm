import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

const COMMENT_ID = "11111111-2222-4333-8444-555555555555";

async function setConfig(ctx: ScenarioContext, key: string, value: string): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", scopeId: null, key, value, isSecret: false },
  });
  expectStatus(response, [200], `set config ${key}`);
  return asString(asRecord(response.json).id, `config ${key} id`);
}

/**
 * `/share/*` and `/site/*` (public agent-fs pages, proxied) and Comb's review-batch route.
 * Both depend on global config that a reload applies without a restart, so the scenario sets
 * it, polls for the effect and removes it again. The upstream is a local stub, never a real
 * agent-fs.
 */
export const knowledgeAgentFsEdges: Scenario = {
  name: "knowledge-agentfs-edges",
  order: 580,
  async run(ctx) {
    const configIds: string[] = [];
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        seen.push({ path: url.pathname, authorization: request.headers.get("authorization") });
        if (url.pathname === `/share/tok-${ctx.nonce}`) {
          return new Response(`raw body ${ctx.nonce}`, {
            headers: { "Content-Type": "text/plain", "Cache-Control": "max-age=60" },
          });
        }
        if (url.pathname === `/site/tok-${ctx.nonce}`) {
          return new Response(`<html><body>site ${ctx.nonce}</body></html>`, {
            headers: {
              "Content-Type": "text/html",
              "Content-Security-Policy": "sandbox",
              "Set-Cookie": "leak=1",
            },
          });
        }
        return new Response(JSON.stringify({ error: "not found upstream" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    let upstreamStopped = false;
    const stopUpstream = async () => {
      if (upstreamStopped) return;
      upstreamStopped = true;
      await upstream.stop(true);
    };
    try {
      // ── Everything is off by default ────────────────────────────────────────────────────────
      let response = await ctx.api("GET", `/share/tok-${ctx.nonce}`, { apiKey: null });
      expectStatus(response, [404], "/share while the proxy is off");
      response = await ctx.api("GET", `/site/tok-${ctx.nonce}`, { apiKey: null });
      expectStatus(response, [404], "/site while the proxy is off");
      const reviewBody = {
        orgId: "org-e2e",
        driveId: "drive-e2e",
        commentIds: [COMMENT_ID],
        scopePath: "/docs/",
      };
      response = await ctx.api("POST", "/api/comb/review-batches", { body: reviewBody });
      expectStatus(response, [404], "Comb review batch while Comb is off");
      expect(
        asRecord(response.json).error === "Comb is not enabled",
        "Comb off answers before it parses the body",
      );
      response = await ctx.api("POST", "/api/comb/review-batches", { body: {} });
      expectStatus(response, [404], "Comb off ignores an invalid body");

      // ── Proxy on: public pages stream from the upstream ─────────────────────────────────────
      const upstreamUrl = `http://127.0.0.1:${upstream.port}`;
      configIds.push(await setConfig(ctx, "AGENT_FS_API_URL", upstreamUrl));
      configIds.push(await setConfig(ctx, "AGENT_FS_PROXY", "true"));
      const proxied = await pollUntil(
        async () =>
          (await ctx.api("GET", `/share/tok-${ctx.nonce}`, { apiKey: null })).status === 200,
        15_000,
        250,
      );
      expect(proxied, "the config reload never switched the agent-fs proxy on");

      response = await ctx.api("GET", `/share/tok-${ctx.nonce}`);
      expectStatus(response, [200], "/share through the proxy");
      expect(
        response.text === `raw body ${ctx.nonce}` &&
          response.headers.get("content-type") === "text/plain" &&
          response.headers.get("cache-control") === "max-age=60",
        "the upstream body and allow-listed headers are streamed",
      );
      const withSwarmKey = seen.filter((entry) => entry.path === `/share/tok-${ctx.nonce}`);
      expect(
        withSwarmKey.length > 0 && withSwarmKey.every((entry) => entry.authorization === null),
        "the swarm API key must never be forwarded upstream",
      );
      response = await ctx.api("GET", `/share/tok-${ctx.nonce}`, {
        apiKey: null,
        headers: { Authorization: "Bearer af_e2e_key" },
      });
      expectStatus(response, [200], "/share with an agent-fs key");
      expect(
        seen.at(-1)?.authorization === "Bearer af_e2e_key",
        "an af_ bearer is forwarded to agent-fs",
      );
      response = await ctx.api("GET", `/site/tok-${ctx.nonce}`, { apiKey: null });
      expectStatus(response, [200], "/site through the proxy");
      expect(
        response.text.includes(`site ${ctx.nonce}`) &&
          response.headers.get("content-security-policy") === "sandbox" &&
          response.headers.get("set-cookie") === null,
        "the sandbox CSP is kept and upstream cookies are dropped",
      );
      response = await ctx.api("GET", `/share/missing-${ctx.nonce}`, { apiKey: null });
      expectStatus(response, [404], "an unknown share token");
      expect(
        asRecord(response.json).error === "not found upstream",
        "upstream 404 body is relayed",
      );

      // ── Comb: enabled by config, still no agent-fs drive ────────────────────────────────────
      configIds.push(await setConfig(ctx, "COMB_ENABLED", "true"));
      const combOn = await pollUntil(
        async () =>
          (await ctx.api("POST", "/api/comb/review-batches", { body: {} })).status !== 404,
        15_000,
        250,
      );
      expect(combOn, "the config reload never switched Comb on");
      response = await ctx.api("POST", "/api/comb/review-batches", { body: {} });
      expectStatus(response, [400], "Comb review batch with an empty body");
      for (const [label, body] of [
        ["no comment ids", { ...reviewBody, commentIds: [] }],
        ["a non-UUID comment id", { ...reviewBody, commentIds: ["not-a-uuid"] }],
        ["more than 50 comment ids", { ...reviewBody, commentIds: Array(51).fill(COMMENT_ID) }],
        ["a relative scope path", { ...reviewBody, scopePath: "docs/" }],
        ["a traversal scope path", { ...reviewBody, scopePath: "/docs/../secrets" }],
        ["a note above 4000 characters", { ...reviewBody, note: "n".repeat(4001) }],
      ] as const) {
        response = await ctx.api("POST", "/api/comb/review-batches", { body });
        expectStatus(response, [400], `Comb review batch with ${label}`);
      }
      response = await ctx.api("POST", "/api/comb/review-batches", { body: reviewBody });
      expectStatus(response, [503], "Comb review batch before the swarm has a drive");
      expect(
        asRecord(response.json).error === "The swarm has no agent-fs drive yet" &&
          Array.isArray(asRecord(response.json).skipped),
        `503 carries the batch error envelope: ${response.text}`,
      );
      response = await ctx.api("POST", "/api/comb/review-batches", {
        body: reviewBody,
        apiKey: null,
      });
      expectStatus(response, [401], "Comb review batch without credentials");

      configIds.push(await setConfig(ctx, "AGENT_FS_DEFAULT_ORG_ID", `org-${ctx.nonce}`));
      configIds.push(await setConfig(ctx, "AGENT_FS_DEFAULT_DRIVE_ID", `drive-${ctx.nonce}`));
      const drivePinned = await pollUntil(
        async () =>
          (await ctx.api("POST", "/api/comb/review-batches", { body: reviewBody })).status === 400,
        15_000,
        250,
      );
      expect(drivePinned, "the swarm drive config never took effect");
      response = await ctx.api("POST", "/api/comb/review-batches", { body: reviewBody });
      expect(
        asRecord(response.json).error === "Comb sends comments from the swarm drive only",
        `a foreign drive is refused: ${response.text}`,
      );
      response = await ctx.api("POST", "/api/comb/review-batches", {
        body: { ...reviewBody, orgId: `org-${ctx.nonce}`, driveId: `drive-${ctx.nonce}` },
      });
      // The stub upstream is not agent-fs: without a bootstrap key the swarm has no agent-fs
      // provider, so the batch stops before it reads any comment.
      expect(
        [502, 503].includes(response.status),
        `swarm drive without agent-fs: ${response.status} ${response.text}`,
      );
      expect(
        response.status === 503
          ? asRecord(response.json).error === "agent-fs is not set up for this swarm"
          : String(asRecord(response.json).error).includes("agent-fs"),
        `agent-fs setup error: ${response.text}`,
      );

      // ── Upstream down: the proxy answers 502 ────────────────────────────────────────────────
      await stopUpstream();
      response = await ctx.api("GET", `/share/tok-${ctx.nonce}`, { apiKey: null });
      expectStatus(response, [502], "/share while agent-fs is unreachable");
      expect(asRecord(response.json).error === "agent-fs upstream unavailable", "502 body");
      response = await ctx.api("GET", `/site/tok-${ctx.nonce}`, { apiKey: null });
      expectStatus(response, [502], "/site while agent-fs is unreachable");
    } finally {
      await stopUpstream();
      for (const id of configIds) await ctx.api("DELETE", `/api/config/${id}`);
      // Wait for the reload so later scenarios see the default (off) behaviour again.
      await pollUntil(
        async () =>
          (await ctx.api("GET", `/share/tok-${ctx.nonce}`, { apiKey: null })).status === 404 &&
          (await ctx.api("POST", "/api/comb/review-batches", { body: {} })).status === 404,
        15_000,
        250,
      );
    }
  },
};
