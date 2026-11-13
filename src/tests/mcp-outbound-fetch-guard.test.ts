import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createMcpServer, initDb } from "../be/db";
import { listMcpServerTools } from "../be/mcp-proxy";
import { discoverProtectedResourceMetadata } from "../oauth/mcp-wrapper";
import { setFakeDnsAnswer } from "./fake-dns";

// No lookup leaves the process: `mcp.public.test` resolves to a public address
// (reserved test name), `rebind.public.test` to loopback.
setFakeDnsAnswer("rebind.public.test", ["127.0.0.1"]);

const TEST_DB_PATH = "./test-mcp-outbound-fetch-guard.sqlite";
const originalFetch = globalThis.fetch;
const savedEnv = {
  NODE_ENV: process.env.NODE_ENV,
  MCP_OAUTH_ALLOW_PRIVATE_HOSTS: process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS,
  ALLOW_PRIVATE_NETWORK_URLS: process.env.ALLOW_PRIVATE_NETWORK_URLS,
};

type Seen = { host: string; hostname: string; href: string };

/**
 * A fetch stand-in with the platform's redirect behaviour: unless the caller
 * passes `redirect: "manual"` or `"error"`, a 3xx with Location is followed
 * inside fetch, as the real one does. Requests are routed by the Host header
 * (an address-pinned request keeps the original name there).
 */
function installFetch(route: (host: string, url: URL) => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const hostHeader = new Headers(init?.headers).get("host");
    let host = hostHeader ?? url.host;
    for (let hop = 0; hop < 6; hop++) {
      seen.push({ host, hostname: url.hostname, href: url.href });
      const res = route(host, url);
      const location = res.headers.get("location");
      const followed = (init?.redirect ?? "follow") === "follow";
      if (!followed || !location || ![301, 302, 303, 307, 308].includes(res.status)) return res;
      url = new URL(location, url);
      host = url.host;
    }
    throw new Error("too many redirects");
  }) as typeof fetch;
  return seen;
}

const isLoopback = (s: Seen) =>
  s.hostname === "127.0.0.1" || s.host.startsWith("127.0.0.1") || s.host === "rebind.public.test";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  process.env.NODE_ENV = "production";
  delete process.env.MCP_OAUTH_ALLOW_PRIVATE_HOSTS;
  delete process.env.ALLOW_PRIVATE_NETWORK_URLS;
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  closeDb();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeDbFiles(TEST_DB_PATH);
});

describe("MCP OAuth metadata discovery outbound requests", () => {
  test("control: a public resource's metadata is fetched and parsed", async () => {
    const seen = installFetch(() =>
      Response.json({ resource: "https://mcp.public.test/mcp", authorization_servers: [] }),
    );
    const prmd = await discoverProtectedResourceMetadata("https://mcp.public.test/mcp");
    expect(prmd?.resource).toBe("https://mcp.public.test/mcp");
    expect(seen.length).toBeGreaterThan(0);
  });

  test("control: a loopback resource URL is refused before any request", async () => {
    const seen = installFetch(() => new Response("unexpected", { status: 500 }));
    await discoverProtectedResourceMetadata("https://127.0.0.1/mcp");
    expect(seen).toEqual([]);
  });

  test("does not follow a redirect from a public host to a loopback address", async () => {
    const seen = installFetch((host) =>
      host === "mcp.public.test"
        ? new Response(null, { status: 307, headers: { location: "https://127.0.0.1/internal" } })
        : Response.json({ resource: "internal" }),
    );
    const prmd = await discoverProtectedResourceMetadata("https://mcp.public.test/mcp");
    expect(seen.filter(isLoopback)).toEqual([]);
    expect(prmd).toBeNull();
  });

  test("does not connect to a name that resolves to a loopback address", async () => {
    const seen = installFetch(() => Response.json({ resource: "internal" }));
    const prmd = await discoverProtectedResourceMetadata("https://rebind.public.test/mcp");
    expect(seen.filter(isLoopback)).toEqual([]);
    expect(prmd).toBeNull();
  });
});

describe("Script MCP proxy outbound requests", () => {
  const mcpResponses = () => {
    let n = 0;
    return () => {
      n += 1;
      if (n === 1) return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
      if (n === 2) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    };
  };

  test("control: a public MCP server is reachable", async () => {
    const server = await createMcpServer({
      name: `public-${crypto.randomUUID()}`,
      transport: "http",
      url: "https://mcp.public.test/streamable",
    });
    const next = mcpResponses();
    const seen = installFetch(() => next());
    await expect(listMcpServerTools(server.id)).resolves.toEqual([]);
    expect(seen.length).toBe(3);
  });

  test("does not follow a redirect from the MCP server to a loopback address", async () => {
    const server = await createMcpServer({
      name: `redirect-${crypto.randomUUID()}`,
      transport: "http",
      url: "https://mcp.public.test/streamable",
    });
    const next = mcpResponses();
    const seen = installFetch((host) =>
      host === "mcp.public.test"
        ? new Response(null, { status: 307, headers: { location: "https://127.0.0.1/internal" } })
        : next(),
    );
    await listMcpServerTools(server.id).catch(() => undefined);
    expect(seen.filter(isLoopback)).toEqual([]);
  });

  test("does not connect to an MCP server name that resolves to a loopback address", async () => {
    const server = await createMcpServer({
      name: `rebind-${crypto.randomUUID()}`,
      transport: "http",
      url: "https://rebind.public.test/streamable",
    });
    const next = mcpResponses();
    const seen = installFetch(() => next());
    await expect(listMcpServerTools(server.id)).rejects.toThrow();
    expect(seen.filter(isLoopback)).toEqual([]);
  });
});
