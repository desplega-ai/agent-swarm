import { expect, test } from "bun:test";
import { parseWorkerTokenArgs, runWorkerToken } from "../commands/worker-token";

const env = { MCP_BASE_URL: "http://swarm.test", AGENT_SWARM_API_KEY: "operator-key-for-test" };

function fakeFetch(agents: { id: string; name: string }[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/api/agents")) return Response.json({ agents });
    if (init?.method === "DELETE") return Response.json({ revoked: 1 });
    return Response.json({ plaintext: "minted-value", expiresAt: null, agentCreated: true });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("argument parsing requires one action and exactly one agent selector", () => {
  expect(parseWorkerTokenArgs(["create", "--name", "w"]).error).toBeUndefined();
  expect(parseWorkerTokenArgs(["create"]).error).toContain("exactly one");
  expect(parseWorkerTokenArgs(["create", "--name", "w", "--agent-id", "a"]).error).toContain(
    "exactly one",
  );
  expect(parseWorkerTokenArgs(["--name", "w"]).error).toContain("Missing action");
  expect(parseWorkerTokenArgs(["create", "--name", "w", "--ttl-days", "0"]).error).toContain(
    "--ttl-days",
  );
  expect(parseWorkerTokenArgs(["create", "--bogus"]).error).toContain("Unknown argument");
});

test("create by an unused name makes the agent and prints only the token to stdout", async () => {
  const { calls, impl } = fakeFetch([]);
  const io = capture();
  const code = await runWorkerToken(["create", "--name", "w1", "--ttl-days", "2"], {
    env,
    fetch: impl,
    ...io,
  });
  expect(code).toBe(0);
  expect(io.out).toEqual(["minted-value"]);
  expect(io.err.join("\n")).not.toContain("minted-value");
  const mint = calls[1]!;
  expect(mint.method).toBe("POST");
  expect(mint.url).toMatch(/^http:\/\/swarm\.test\/api\/agents\/[0-9a-f-]{36}\/token$/);
  expect(mint.body).toEqual({ name: "w1", ttlMs: 2 * 86_400_000 });
});

test("rotate and revoke resolve an existing name; an ambiguous name fails", async () => {
  const agents = [{ id: "agent-1", name: "w1" }];
  for (const [action, method, suffix] of [
    ["rotate", "POST", "/rotate"],
    ["revoke", "DELETE", ""],
  ] as const) {
    const { calls, impl } = fakeFetch(agents);
    expect(await runWorkerToken([action, "--name", "w1"], { env, fetch: impl, ...capture() })).toBe(
      0,
    );
    expect(calls[1]).toMatchObject({
      method,
      url: `http://swarm.test/api/agents/agent-1/token${suffix}`,
    });
  }
  const { impl } = fakeFetch([...agents, { id: "agent-2", name: "w1" }]);
  const io = capture();
  expect(await runWorkerToken(["rotate", "--name", "w1"], { env, fetch: impl, ...io })).toBe(1);
  expect(io.err.join("\n")).toContain("Several agents");
});
