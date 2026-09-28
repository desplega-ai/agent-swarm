import { describe, expect, test } from "bun:test";
import { createSessionPanelHttpClient } from "./http-client";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(response: unknown, status = 200) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
  return { calls, impl };
}

describe("createSessionPanelHttpClient", () => {
  test("lists the viewer's sessions under a context-key prefix", async () => {
    const sessions = [
      { root: { id: "r1" }, lastActivityAt: "x", latestStatus: "completed", chainTaskCount: 1 },
    ];
    const { calls, impl } = fakeFetch({ sessions, total: 1 });
    const client = createSessionPanelHttpClient({
      baseUrl: "https://api.test/",
      apiKey: "k",
      fetch: impl,
    });

    const out = await client.listSessions({
      contextKeyPrefix: "task:ui:workflow:w%3A1:",
      requestedByUserId: "u1",
    });

    expect(out).toEqual(sessions as never);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://api.test/api/sessions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: "ui",
      contextKeyPrefix: "task:ui:workflow:w%3A1:",
      limit: "20",
      requestedByUserId: "u1",
    });
    expect(calls[0]?.headers.Authorization).toBe("Bearer k");
  });

  test("same-origin base URL and custom headers", async () => {
    const { calls, impl } = fakeFetch({ sessions: [] });
    const client = createSessionPanelHttpClient({
      baseUrl: "",
      headers: () => ({ "X-App": "a1" }),
      fetch: impl,
    });
    await client.listSessions({ contextKeyPrefix: "p:" });
    expect(calls[0]?.url.startsWith("/api/sessions?")).toBe(true);
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.headers["X-App"]).toBe("a1");
  });

  test("creates sessions and follow-ups with the right shape", async () => {
    const { calls, impl } = fakeFetch({ id: "t1" });
    const client = createSessionPanelHttpClient({ baseUrl: "", fetch: impl });

    expect(
      await client.createSession({ task: "hi", contextKey: "p:n1", requestedByUserId: "u1" }),
    ).toEqual({
      id: "t1",
    } as never);
    await client.createFollowUp({ task: "more", parentTaskId: "t1" });
    await client.steer("t/1", { message: "now" });

    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      [
        "POST",
        "/api/tasks",
        { task: "hi", contextKey: "p:n1", requestedByUserId: "u1", source: "ui" },
      ],
      ["POST", "/api/tasks", { task: "more", parentTaskId: "t1", source: "ui" }],
      ["POST", "/api/tasks/t%2F1/steer", { message: "now", mode: "queue", source: "ui" }],
    ]);
  });

  test("surfaces the server's error message", async () => {
    const { impl } = fakeFetch({ error: "nope" }, 400);
    const client = createSessionPanelHttpClient({ baseUrl: "", fetch: impl });
    await expect(client.getSession("r1")).rejects.toThrow("nope");
  });
});
