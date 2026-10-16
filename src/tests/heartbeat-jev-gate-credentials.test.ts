import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, initDb, upsertSwarmConfig } from "../be/db";
import { buildScriptCredentialBindingsWithFailures } from "../be/script-credential-broker";
import { patchFetchWithEgressSubstitution } from "../scripts-runtime/egress-secrets";
import { runScript } from "../scripts-runtime/loader";
import { registerSystemOneDecideTool } from "../tools/system-one-decide";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

// The Jev gate's two provider keys must never reach a script's JavaScript realm,
// and an OpenRouter key must never go to openrouter.ai while the deployment
// routes OpenRouter through a gateway. These tests drive the real credential
// resolver, the real fetch patch and the real script runtime.

const TYPESAFE_KEY = "typesafe-jev-regression-key";
const OPENROUTER_KEY = "openrouter-jev-regression-key";
const GATEWAY = "https://gateway.example/v1";

const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

let agentId: string;

beforeAll(async () => {
  initDb(":memory:");
  agentId = (await createAgent({ name: "jev-cred-lead", isLead: true, status: "idle" })).id;
  for (const [key, value] of [
    ["TYPESAFE_API_KEY", TYPESAFE_KEY],
    ["OPENROUTER_API_KEY", OPENROUTER_KEY],
  ]) {
    await upsertSwarmConfig({ scope: "global", key, value, isSecret: true });
  }
});

afterAll(() => closeDb());

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "example-jev-gate-credentials-api-key-123";
  // The gateway is set only in the environment, never as a stored config row.
  process.env.OPENROUTER_BASE_URL = GATEWAY;
  refreshSecretScrubberCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

/** Records the Authorization header of every request that reaches the network layer. */
function recordAuthorization(): Array<{ url: string; authorization: string | null }> {
  const sent: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({
      model: "jev-latest",
      answers: { act: { type: "noul", noul: 0.2 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
  }) as typeof fetch;
  return sent;
}

describe("script egress never carries the Jev keys", () => {
  test("a script fetch to openrouter.ai or api.typesafe.ai gets no stored key", async () => {
    const { egressSecrets } = await buildScriptCredentialBindingsWithFailures({ agentId });
    const sent = recordAuthorization();
    patchFetchWithEgressSubstitution(egressSecrets);
    await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: { Authorization: "Bearer [REDACTED:OPENROUTER_API_KEY]" },
      body: "{}",
    });
    await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: "Bearer [REDACTED:TYPESAFE_API_KEY]" },
      body: "{}",
    });

    expect(sent).toHaveLength(2);
    for (const { authorization } of sent) {
      expect(authorization ?? "").not.toContain(OPENROUTER_KEY);
      expect(authorization ?? "").not.toContain(TYPESAFE_KEY);
    }
    expect(egressSecrets.map((s) => s.configKey)).not.toContain("OPENROUTER_API_KEY");
    expect(egressSecrets.map((s) => s.configKey)).not.toContain("TYPESAFE_API_KEY");
  });

  spawnTest("a script that hooks Headers.prototype.set captures neither key", async () => {
    // Same env-sourced resolution runScript() uses when the caller passes no bindings.
    process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;
    process.env.OPENROUTER_API_KEY = OPENROUTER_KEY;
    const output = await runScript({
      agentId,
      resources: { memoryMb: 2048 },
      source: `
        async function capture(url, placeholder) {
          let captured = "";
          const savedSet = Headers.prototype.set;
          Headers.prototype.set = function (key, value) {
            if (String(key).toLowerCase() === "authorization") captured = String(value).slice(7);
            return savedSet.call(this, key, value);
          };
          const abort = new AbortController();
          abort.abort();
          await fetch(url, {
            signal: abort.signal,
            headers: { Authorization: "Bearer " + placeholder },
          }).catch(() => {});
          Headers.prototype.set = savedSet;
          return btoa(captured);
        }
        export default async () => ({
          typesafe: await capture("https://api.typesafe.ai/", "[REDACTED:TYPESAFE_API_KEY]"),
          openrouter: await capture("https://openrouter.ai/", "[REDACTED:OPENROUTER_API_KEY]"),
        });
      `,
    });

    expect(output.error).toBeUndefined();
    const result = output.result as { typesafe: string; openrouter: string };
    expect(atob(result.typesafe)).not.toContain(TYPESAFE_KEY);
    expect(atob(result.openrouter)).not.toContain(OPENROUTER_KEY);
  });
});

describe("system-one-decide keeps the key on the server", () => {
  const extra = () => ({ sessionId: "s", requestInfo: { headers: { "x-agent-id": agentId } } });
  const tool = () => {
    const server = new McpServer({ name: "jev-cred-decide", version: "1" });
    registerSystemOneDecideTool(server);
    return (server as any)._registeredTools["system-one-decide"];
  };
  const request = (provider: string) => ({
    provider,
    state: { now: "2026-10-16 10:00 UTC" },
    questions: { act: { type: "noul", instructions: "Act now?" } },
    maxRetries: 0,
  });

  test("openrouter is refused while OPENROUTER_BASE_URL is a gateway, with no request sent", async () => {
    const sent = recordAuthorization();
    const result = await tool().handler(request("openrouter"), extra());
    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("OPENROUTER_BASE_URL points at a gateway");
    expect(sent).toHaveLength(0);
  });

  test("typesafe answers; the key goes only to api.typesafe.ai and never into the result", async () => {
    const sent = recordAuthorization();
    const result = await tool().handler(request("typesafe"), extra());
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.answers.act.noul).toBe(0.2);
    expect(sent).toEqual([
      { url: "https://api.typesafe.ai/v1/systemone", authorization: `Bearer ${TYPESAFE_KEY}` },
    ]);
    expect(JSON.stringify(result)).not.toContain(TYPESAFE_KEY);
  });
});
