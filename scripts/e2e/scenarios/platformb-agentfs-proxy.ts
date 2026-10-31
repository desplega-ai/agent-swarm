import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { Cleanup, registerWorker } from "./platformb-helpers";

type Seen = {
  method: string;
  /** Path and query exactly as the upstream received them. */
  target: string;
  headers: Record<string, string>;
  body: string;
};

/** A stand-in for the agent-fs server: records every request and answers by path. */
function startFakeAgentFs() {
  const seen: Seen[] = [];
  const bytes = new Uint8Array(65_536).map((_, index) => (index * 7) % 256);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body =
        request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      seen.push({
        method: request.method,
        target: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body,
      });
      if (url.pathname === "/echo") {
        return Response.json(
          { ok: true },
          {
            headers: {
              "x-agent-fs-version": "7",
              "x-agent-fs-content-hash": "hash-abc",
              etag: '"e1"',
              "cache-control": "no-store",
              "content-security-policy": "sandbox",
              // The proxy must drop everything outside its allowlist.
              "set-cookie": "upstream=1",
              "x-upstream-secret": "nope",
            },
          },
        );
      }
      if (url.pathname === "/bytes") {
        return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
      }
      if (url.pathname === "/status-401") {
        return Response.json({ error: "af key required" }, { status: 401 });
      }
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
      }
      if (url.pathname.startsWith("/share/") || url.pathname.startsWith("/site/")) {
        return new Response(`<html>page ${url.pathname}</html>`, {
          headers: { "content-type": "text/html", "access-control-allow-origin": "*" },
        });
      }
      return Response.json({ ok: true, path: url.pathname });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    seen,
    bytes,
    stop: () => server.stop(true),
  };
}

async function setConfig(ctx: ScenarioContext, key: string, value: string): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", scopeId: null, key, value, isSecret: false },
  });
  expectStatus(response, [200], `set ${key}`);
  return asString(asRecord(response.json).id, `${key} config id`);
}

/**
 * The agent-fs pass-through proxy. With the local backend it is off and every method answers 404.
 * The scenario then points AGENT_FS_API_URL at a fake agent-fs server and turns AGENT_FS_PROXY on
 * through the config API, the way an operator does, and checks what crosses the proxy: the path
 * and query, the header allowlists in both directions, the swarm key staying home, streamed
 * bodies, upstream statuses, the registration gate with its rate limit, the unreachable upstream,
 * and the public share and site pages. Removing the config rows turns the proxy off again.
 */
export const platformbAgentFsProxy: Scenario = {
  name: "platformb-agentfs-proxy",
  order: 685,
  async run(ctx) {
    const cleanup = new Cleanup();
    const fake = startFakeAgentFs();
    const configIds: string[] = [];
    cleanup.add("stop the fake agent-fs", () => fake.stop());
    cleanup.add("remove proxy config", async () => {
      for (const id of configIds) await ctx.api("DELETE", `/api/config/${id}`);
      // The config watcher reloads on a short debounce; wait until the proxy is off for later scenarios.
      await pollUntil(
        async () => (await ctx.api("GET", `/agentfs/off-${ctx.nonce}`)).status === 404,
        15_000,
        200,
      );
    });

    await cleanup.around(async () => {
      const workerId = await registerWorker(ctx, `e2e-platformb-proxy-${ctx.nonce}`);

      // --- off: the local backend serves no /agentfs, /share or /site.
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await ctx.api(method, `/agentfs/off-${ctx.nonce}`, {
          body: method === "GET" || method === "DELETE" ? undefined : { a: 1 },
        });
        expectStatus(response, [404], `${method} /agentfs with the proxy off`);
      }
      expectStatus(
        await ctx.api("GET", `/share/off-${ctx.nonce}`),
        [404],
        "/share with the proxy off",
      );
      expectStatus(
        await ctx.api("GET", `/site/off-${ctx.nonce}`),
        [404],
        "/site with the proxy off",
      );
      expect(fake.seen.length === 0, "The fake agent-fs saw a request while the proxy was off");

      // --- on: the upstream URL and the flag come from global config.
      configIds.push(await setConfig(ctx, "AGENT_FS_API_URL", fake.origin));
      configIds.push(await setConfig(ctx, "AGENT_FS_PROXY", "true"));
      const live = await pollUntil(
        async () => (await ctx.api("GET", `/agentfs/probe-${ctx.nonce}`)).status === 200,
        15_000,
        200,
      );
      expect(live, "The proxy never started forwarding after AGENT_FS_PROXY was set");
      fake.seen.length = 0;

      // --- request side: path, query, allowlisted headers; no swarm key, cookie or agent id.
      const afKey = `af_e2e_${ctx.nonce}`;
      let response = await ctx.api("GET", "/agentfs/echo?x=1&y=two%20words", {
        apiKey: afKey,
        agentId: workerId,
        headers: {
          Cookie: "session=secret",
          Accept: "application/json",
          "If-None-Match": '"abc"',
          "X-Agent-FS-Message": "hello",
          "X-Custom-Header": "dropped",
        },
      });
      expectStatus(response, [200], "GET through the proxy");
      let upstream = fake.seen.at(-1);
      expect(upstream, "The fake agent-fs saw nothing");
      expect(
        upstream.method === "GET" && upstream.target === "/echo?x=1&y=two%20words",
        `Upstream got ${upstream.method} ${upstream.target}`,
      );
      expect(
        upstream.headers.authorization === `Bearer ${afKey}`,
        "An agent-fs key was not forwarded",
      );
      expect(
        upstream.headers.accept === "application/json" &&
          upstream.headers["if-none-match"] === '"abc"' &&
          upstream.headers["x-agent-fs-message"] === "hello",
        "An allowlisted request header was dropped",
      );
      expect(
        upstream.headers.cookie === undefined &&
          upstream.headers["x-agent-id"] === undefined &&
          upstream.headers["x-custom-header"] === undefined,
        `Upstream received a header outside the allowlist: ${JSON.stringify(upstream.headers)}`,
      );

      // The swarm key is never forwarded, and the proxy routes need no key at all.
      await ctx.api("GET", "/agentfs/echo", { agentId: workerId });
      upstream = fake.seen.at(-1);
      expect(
        upstream?.headers.authorization === undefined,
        "The swarm API key was forwarded to agent-fs",
      );
      response = await ctx.api("GET", "/agentfs/echo", { apiKey: null });
      expectStatus(response, [200], "GET through the proxy with no key");
      expect(
        fake.seen.at(-1)?.headers.authorization === undefined,
        "A request with no key reached agent-fs with one",
      );

      // --- response side: allowlisted headers cross, the rest stay behind.
      const headers = response.headers;
      expect(
        headers.get("x-agent-fs-version") === "7" &&
          headers.get("x-agent-fs-content-hash") === "hash-abc" &&
          headers.get("etag") === '"e1"' &&
          headers.get("content-security-policy") === "sandbox" &&
          (headers.get("content-type") ?? "").includes("json"),
        "An allowlisted response header did not cross the proxy",
      );
      expect(
        headers.get("set-cookie") === null && headers.get("x-upstream-secret") === null,
        "A response header outside the allowlist crossed the proxy",
      );
      expect(asRecord(response.json).ok === true, "The upstream JSON body did not cross");

      // --- bodies and methods stream through.
      const payload = JSON.stringify({ note: `payload ${ctx.nonce}`, filler: "x".repeat(200_000) });
      for (const method of ["POST", "PUT", "PATCH"] as const) {
        response = await ctx.api(method, `/agentfs/body-${method.toLowerCase()}`, {
          apiKey: afKey,
          rawBody: payload,
          headers: { "Content-Type": "application/json" },
        });
        expectStatus(response, [200], `${method} through the proxy`);
        upstream = fake.seen.at(-1);
        expect(
          upstream?.method === method &&
            upstream.target === `/body-${method.toLowerCase()}` &&
            upstream.body === payload &&
            upstream.headers["content-type"] === "application/json",
          `${method} body did not reach the upstream intact`,
        );
      }
      response = await ctx.api("DELETE", "/agentfs/removed", { apiKey: afKey });
      expectStatus(response, [200], "DELETE through the proxy");
      expect(
        fake.seen.at(-1)?.method === "DELETE" && fake.seen.at(-1)?.target === "/removed",
        "DELETE did not reach the upstream",
      );

      // A binary download keeps every byte.
      const started = performance.now();
      const bytesResponse = await fetch(`${ctx.baseUrl}/agentfs/bytes`, {
        signal: AbortSignal.timeout(30_000),
      });
      ctx.recordHttpCall(
        "GET",
        "/agentfs/bytes",
        bytesResponse.status,
        performance.now() - started,
      );
      const received = new Uint8Array(await bytesResponse.arrayBuffer());
      expect(
        bytesResponse.status === 200 &&
          received.length === fake.bytes.length &&
          received.every((byte, index) => byte === fake.bytes[index]),
        "A binary body changed crossing the proxy",
      );

      // --- upstream statuses and redirects pass through untouched.
      response = await ctx.api("GET", "/agentfs/status-401");
      expectStatus(response, [401], "upstream 401");
      expect(asRecord(response.json).error === "af key required", "Upstream 401 body changed");
      const redirect = await ctx.api("GET", "/agentfs/redirect", { redirect: "manual" });
      expectStatus(redirect, [302], "upstream redirect is not followed");
      expect(redirect.headers.get("location") === "/elsewhere", "Redirect Location was dropped");

      // --- paths that fetch or the upstream router would rewrite are refused.
      response = await ctx.api("GET", "/agentfs/..%2Fetc");
      expectStatus(response, [400], "dot segment behind an encoded slash");
      expect(asRecord(response.json).error === "Invalid path", "Refusal is not Invalid path");
      const before = fake.seen.length;
      await ctx.api("GET", "/agentfs/%2e%2e%2fetc");
      expect(fake.seen.length === before, "A non-canonical path reached the upstream");

      // --- registration needs a swarm credential and is rate limited (5 per minute per address).
      const registerPath = "/agentfs/auth%2Fregister";
      const registerBody = { email: `e2e-${ctx.nonce}@example.invalid`, password: "pw" };
      response = await ctx.api("POST", registerPath, { apiKey: null, body: registerBody });
      expectStatus(response, [401], "register with no swarm credential");
      expect(
        String(asRecord(response.json).error).includes("needs a swarm API key or user token"),
        `Register refusal is ${String(asRecord(response.json).error)}`,
      );
      const seenBeforeRegister = fake.seen.length;
      response = await ctx.api("POST", registerPath, { body: registerBody });
      expectStatus(response, [200], "register with the operator key");
      upstream = fake.seen.at(-1);
      expect(fake.seen.length === seenBeforeRegister + 1, "Register did not reach the upstream");
      expect(
        upstream?.method === "POST" &&
          decodeURIComponent(upstream.target) === "/auth/register" &&
          upstream.headers.authorization === undefined &&
          upstream.headers["content-type"] === "application/json" &&
          JSON.stringify(JSON.parse(upstream.body)) === JSON.stringify(registerBody),
        `Register reached the upstream as ${JSON.stringify(upstream)}`,
      );
      response = await ctx.api("POST", registerPath, {
        rawBody: "{not json",
        headers: { "Content-Type": "application/json" },
      });
      expectStatus(response, [400], "register with invalid JSON");
      response = await ctx.api("POST", registerPath, { body: [registerBody] });
      expectStatus(response, [400], "register with a JSON array");
      response = await ctx.api("POST", registerPath, {
        body: { email: `e2e-${ctx.nonce}@example.invalid`, filler: "x".repeat(20_000) },
      });
      expectStatus(response, [413], "register with a body over 16 KB");
      response = await ctx.api("POST", registerPath, { body: registerBody });
      expectStatus(response, [429], "the sixth registration inside the minute");
      expect(response.headers.get("retry-after") === "12", "The 429 carries no Retry-After");
      expect(asRecord(response.json).error === "rate_limited", "The 429 body is not rate_limited");
      expect(
        fake.seen.length === seenBeforeRegister + 1,
        "A refused registration still reached the upstream",
      );

      // --- public pages go through the same proxy, GET only.
      response = await ctx.api("GET", "/share/token-1", { apiKey: null });
      expectStatus(response, [200], "GET /share through the proxy");
      expect(
        response.text.includes("page /share/token-1") &&
          fake.seen.at(-1)?.target === "/share/token-1" &&
          response.headers.get("access-control-allow-origin") === "*",
        "/share did not reach the upstream path or lost its CORS header",
      );
      response = await ctx.api("GET", "/site/token-2", {
        apiKey: null,
      });
      expectStatus(response, [200], "GET /site through the proxy");
      expect(fake.seen.at(-1)?.target === "/site/token-2", "/site did not reach the upstream path");

      // --- an unreachable upstream is a 502.
      const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
      const deadOrigin = `http://127.0.0.1:${dead.port}`;
      await dead.stop(true);
      await setConfig(ctx, "AGENT_FS_API_URL", deadOrigin);
      const bad = await pollUntil(
        async () => (await ctx.api("GET", `/agentfs/dead-${ctx.nonce}`)).status === 502,
        15_000,
        200,
      );
      expect(bad, "A dead upstream never produced a 502");
      response = await ctx.api("GET", `/agentfs/dead-${ctx.nonce}`);
      expect(
        asRecord(response.json).error === "agent-fs upstream unavailable",
        `502 body is ${response.text}`,
      );

      // --- removing the config turns the proxy off again.
      for (const id of configIds.splice(0)) {
        expectStatus(await ctx.api("DELETE", `/api/config/${id}`), [200], "remove proxy config");
      }
      const off = await pollUntil(
        async () => (await ctx.api("GET", `/agentfs/after-${ctx.nonce}`)).status === 404,
        15_000,
        200,
      );
      expect(off, "The proxy kept forwarding after its config was removed");
    });
  },
};
