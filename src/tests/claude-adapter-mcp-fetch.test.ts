import { afterEach, describe, expect, test } from "bun:test";
import {
  ClaudeMcpFetchError,
  fetchInstalledMcpServersForClaude,
} from "../providers/claude-adapter";

const realFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installMockFetch(
  responder: (call: FetchCall, attempt: number) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return responder({ url, init }, calls.length);
  }) as typeof fetch;
  return { calls };
}

describe("claude-adapter fetchInstalledMcpServersForClaude", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns mapped entries on 200 with active servers", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            servers: [
              {
                name: "agent-swarm",
                transport: "http",
                isActive: true,
                isEnabled: true,
                url: "http://api:3013/mcp",
                headers: JSON.stringify({ Authorization: "Bearer x" }),
                resolvedHeaders: { "X-Agent-ID": "agent-1" },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const result = await fetchInstalledMcpServersForClaude("http://api:3013", "k", "agent-1");
    expect(result["agent-swarm"]).toBeDefined();
    expect(result["agent-swarm"].url).toBe("http://api:3013/mcp");
    expect((result["agent-swarm"].headers as Record<string, string>)["X-Agent-ID"]).toBe("agent-1");
    expect(result["agent-swarm"].type).toBe("http");
  });

  test("returns empty object when API has zero active servers (success, not failure)", async () => {
    installMockFetch(() => new Response(JSON.stringify({ servers: [] }), { status: 200 }));
    const result = await fetchInstalledMcpServersForClaude("http://api:3013", "k", "agent-1");
    expect(result).toEqual({});
  });

  test("filters out inactive or disabled servers", async () => {
    installMockFetch(
      () =>
        new Response(
          JSON.stringify({
            servers: [
              { name: "a", transport: "http", isActive: false, isEnabled: true, url: "http://a" },
              { name: "b", transport: "http", isActive: true, isEnabled: false, url: "http://b" },
              { name: "c", transport: "http", isActive: true, isEnabled: true, url: "http://c" },
            ],
          }),
          { status: 200 },
        ),
    );
    const result = await fetchInstalledMcpServersForClaude("http://api:3013", "k", "agent-1");
    expect(Object.keys(result)).toEqual(["c"]);
  });

  test("retries on 5xx and succeeds on a later attempt", async () => {
    const { calls } = installMockFetch((_call, attempt) => {
      if (attempt < 3) return new Response("upstream error", { status: 502 });
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    });
    const result = await fetchInstalledMcpServersForClaude("http://api:3013", "k", "agent-1");
    expect(result).toEqual({});
    expect(calls.length).toBe(3);
  });

  test("throws ClaudeMcpFetchError after exhausting retries on persistent 5xx", async () => {
    const { calls } = installMockFetch(() => new Response("down", { status: 503 }));
    let thrown: unknown;
    try {
      await fetchInstalledMcpServersForClaude("http://api:3013", "k", "agent-1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaudeMcpFetchError);
    expect((thrown as ClaudeMcpFetchError).cause.status).toBe(503);
    expect(calls.length).toBe(3);
  });

  test("throws immediately on 4xx without retrying", async () => {
    const { calls } = installMockFetch(() => new Response("forbidden", { status: 403 }));
    let thrown: unknown;
    try {
      await fetchInstalledMcpServersForClaude("http://api:3013", "k", "agent-1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaudeMcpFetchError);
    expect(calls.length).toBe(1);
  });

  test("throws ClaudeMcpFetchError when fetch itself rejects", async () => {
    const { calls } = installMockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    let thrown: unknown;
    try {
      await fetchInstalledMcpServersForClaude("http://api:3013", "k", "agent-1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaudeMcpFetchError);
    expect(calls.length).toBe(3);
  });

  test("sends Authorization and X-Agent-ID headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    installMockFetch((call) => {
      const headers = call.init?.headers as Record<string, string> | undefined;
      if (headers) capturedHeaders = headers;
      return new Response(JSON.stringify({ servers: [] }), { status: 200 });
    });
    await fetchInstalledMcpServersForClaude("http://api:3013", "secret-key", "agent-42");
    expect(capturedHeaders.Authorization).toBe("Bearer secret-key");
    expect(capturedHeaders["X-Agent-ID"]).toBe("agent-42");
  });
});
