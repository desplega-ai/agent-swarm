import { afterEach, describe, expect, test } from "bun:test";
import { secureMcpServers } from "../providers/acp-adapter";
import {
  type McpLoopbackProxy,
  needsLoopbackProxy,
  startMcpLoopbackProxy,
} from "../providers/mcp-loopback-proxy";
import { getFreePort } from "./test-net";

type Upstream = ReturnType<typeof Bun.serve>;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function track(proxy: McpLoopbackProxy): McpLoopbackProxy {
  cleanups.push(() => proxy.stop());
  return proxy;
}

/** A stand-in MCP endpoint: JSON echo, a slow SSE stream and a redirect. */
function startUpstream(): Upstream {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/prefix/mcp" && req.method === "POST") {
        return Response.json({
          path: url.pathname,
          search: url.search,
          method: req.method,
          body: await req.json(),
          authorization: req.headers.get("authorization"),
          agentId: req.headers.get("x-agent-id"),
          host: req.headers.get("host"),
        });
      }
      if (url.pathname === "/prefix/sse") {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const n of [1, 2, 3]) {
              controller.enqueue(encoder.encode(`event: message\ndata: {"n":${n}}\n\n`));
              await Bun.sleep(30);
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/prefix/redirect") {
        return new Response(null, { status: 302, headers: { Location: "https://example.test/" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return server;
}

describe("needsLoopbackProxy", () => {
  test("only plain HTTP to a non-loopback host needs the forwarder", () => {
    expect(needsLoopbackProxy("http://api:3013/mcp")).toBe(true);
    expect(needsLoopbackProxy("http://10.0.0.5/mcp")).toBe(true);
    // fx accepts only these loopback names; 127.0.0.2 is rejected (fx 0.0.15).
    expect(needsLoopbackProxy("http://127.0.0.2:3013/mcp")).toBe(true);
    expect(needsLoopbackProxy("http://127.0.0.1:3013/mcp")).toBe(false);
    expect(needsLoopbackProxy("http://localhost:3013/mcp")).toBe(false);
    expect(needsLoopbackProxy("http://[::1]:3013/mcp")).toBe(false);
    expect(needsLoopbackProxy("https://swarm.example/mcp")).toBe(false);
    expect(needsLoopbackProxy("not a url")).toBe(false);
  });
});

describe("startMcpLoopbackProxy", () => {
  test("round-trips a JSON POST with its headers, under the upstream path prefix", async () => {
    const upstream = startUpstream();
    const proxy = track(await startMcpLoopbackProxy(`http://127.0.0.1:${upstream.port}/prefix/`));
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${proxy.url}/mcp?session=1`, {
      method: "POST",
      headers: {
        Authorization: "Bearer aseph_proxytest",
        "X-Agent-ID": "agent-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/prefix/mcp",
      search: "?session=1",
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      authorization: "Bearer aseph_proxytest",
      agentId: "agent-1",
      // The upstream sees its own host, not the forwarder's.
      host: `127.0.0.1:${upstream.port}`,
    });
  });

  test("streams SSE events in order as they arrive", async () => {
    const upstream = startUpstream();
    const proxy = track(await startMcpLoopbackProxy(`http://127.0.0.1:${upstream.port}/prefix`));
    const response = await fetch(`${proxy.url}/sse`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let reads = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reads += 1;
      text += decoder.decode(value, { stream: true });
    }
    expect([...text.matchAll(/"n":(\d)/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
    // Delivered incrementally, not buffered into one body.
    expect(reads).toBeGreaterThan(1);
  });

  test("passes a redirect through instead of following it", async () => {
    const upstream = startUpstream();
    const proxy = track(await startMcpLoopbackProxy(`http://127.0.0.1:${upstream.port}/prefix`));
    const response = await fetch(`${proxy.url}/redirect`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.test/");
  });

  test("answers 502 when the upstream is down", async () => {
    const port = await getFreePort();
    const proxy = track(await startMcpLoopbackProxy(`http://127.0.0.1:${port}`));
    const response = await fetch(`${proxy.url}/mcp`, { method: "POST", body: "{}" });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain(
      "MCP loopback proxy: upstream failed",
    );
  });

  test("stop() frees the port and is idempotent", async () => {
    const upstream = startUpstream();
    const proxy = await startMcpLoopbackProxy(`http://127.0.0.1:${upstream.port}/prefix`);
    await proxy.stop();
    await proxy.stop();
    await expect(fetch(`${proxy.url}/sse`)).rejects.toThrow();
  });
});

describe("secureMcpServers", () => {
  test("forwards plain-HTTP non-loopback servers, one forwarder per origin, and drops SSE", async () => {
    const proxies: McpLoopbackProxy[] = [];
    cleanups.push(async () => {
      for (const proxy of proxies) await proxy.stop();
    });
    const servers = await secureMcpServers(
      [
        { type: "http", name: "swarm", url: "http://api:3013/mcp", headers: [] },
        { type: "http", name: "same-origin", url: "http://api:3013/other?x=1", headers: [] },
        { type: "http", name: "secure", url: "https://mcp.example/mcp", headers: [] },
        { type: "http", name: "local", url: "http://127.0.0.1:9/mcp", headers: [] },
        { type: "sse", name: "legacy", url: "https://sse.example/sse", headers: [] },
        { name: "stdio", command: "true", args: [], env: [] },
      ],
      false,
      proxies,
    );
    expect(proxies).toHaveLength(1);
    const forwarded = proxies[0]!.url;
    expect(servers.map((server) => [server.name, "url" in server ? server.url : null])).toEqual([
      ["swarm", `${forwarded}/mcp`],
      ["same-origin", `${forwarded}/other?x=1`],
      ["secure", "https://mcp.example/mcp"],
      ["local", "http://127.0.0.1:9/mcp"],
      ["stdio", null],
    ]);
  });

  test("keeps SSE servers when the agent supports them", async () => {
    const proxies: McpLoopbackProxy[] = [];
    const servers = await secureMcpServers(
      [{ type: "sse", name: "legacy", url: "https://sse.example/sse", headers: [] }],
      true,
      proxies,
    );
    expect(servers.map((server) => server.name)).toEqual(["legacy"]);
    expect(proxies).toEqual([]);
  });
});
