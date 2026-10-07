import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

// Mirrors the agent-swarm.dev connector's handoff from the swarm side:
// discovery → mint a code as the operator → exchange it without auth → the
// same /health + /mcp-user checks the connector runs before it stores a link.
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const connectorHandoff: Scenario = {
  name: "connector-handoff",
  order: 75,
  async run(ctx) {
    const discovery = await ctx.api("GET", "/api/connector/discovery", { apiKey: null });
    expectStatus(discovery, [200], "discovery without auth");
    const discovered = discovery.json as { apiUrl?: unknown; connectUrl?: unknown };
    expect(typeof discovered.apiUrl === "string", "discovery reports apiUrl");
    expect(
      discovered.connectUrl === "https://mcp.agent-swarm.dev/connections",
      `discovery reports the default connect URL, got ${String(discovered.connectUrl)}`,
    );

    const created = await ctx.api("POST", "/api/users", {
      body: { name: `Connector E2E ${ctx.nonce}` },
    });
    expectStatus(created, [200], "create user");
    const userId = (created.json as { user: { id: string } }).user.id;

    expectStatus(
      await ctx.api("POST", `/api/users/${userId}/connector-codes`, { apiKey: null, body: {} }),
      [401],
      "minting a code needs the operator key",
    );
    expectStatus(
      await ctx.api("POST", "/api/users/no-such-user/connector-codes", { body: {} }),
      [404],
      "minting a code for an unknown user",
    );

    // The SUT's public origin is http://, which the connector refuses.
    const refused = await ctx.api("POST", `/api/users/${userId}/connector-codes`, { body: {} });
    expectStatus(refused, [400], "minting a code for a non-https swarm");
    expect(
      String((refused.json as { error?: string }).error).includes("PUBLIC_MCP_BASE_URL"),
      "the non-https error names PUBLIC_MCP_BASE_URL",
    );
    const publicOrigin = `https://swarm-${ctx.nonce}.example.com`;
    const config = await ctx.api("PUT", "/api/config", {
      body: { scope: "global", key: "PUBLIC_MCP_BASE_URL", value: publicOrigin, isSecret: false },
    });
    expectStatus(config, [200, 201], "set PUBLIC_MCP_BASE_URL");
    const configId =
      (config.json as { id?: string; config?: { id?: string } }).config?.id ??
      (config.json as { id?: string }).id;
    try {
      await handoff(ctx, userId, publicOrigin);
    } finally {
      if (configId) await ctx.api("DELETE", `/api/config/${configId}`);
    }
  },
};

async function handoff(ctx: ScenarioContext, userId: string, publicOrigin: string) {
  const rediscovered = await ctx.api("GET", "/api/connector/discovery", { apiKey: null });
  expect(
    (rediscovered.json as { apiUrl?: string }).apiUrl === publicOrigin,
    "discovery reports the configured public origin",
  );
  const minted = await ctx.api("POST", `/api/users/${userId}/connector-codes`, {
    body: { label: "ChatGPT connector" },
  });
  expectStatus(minted, [201], "mint connector code");
  const { code, connectUrl, expiresAt } = minted.json as {
    code: string;
    connectUrl: string;
    expiresAt: string;
  };
  expect(CODE_PATTERN.test(code), "code is 43 base64url chars");
  expect(Date.parse(expiresAt) > Date.now(), "code expires in the future");
  const issued = new URL(connectUrl);
  expect(
    issued.origin + issued.pathname === "https://mcp.agent-swarm.dev/connections",
    `connectUrl base, got ${connectUrl}`,
  );
  expect(issued.searchParams.get("code") === code, "connectUrl carries the code");
  expect(
    issued.searchParams.get("swarm") === publicOrigin,
    `connectUrl swarm matches discovery apiUrl, got ${issued.searchParams.get("swarm")}`,
  );

  // The connector posts with no Authorization header.
  const exchanged = await ctx.api("POST", "/api/connector/exchange", {
    apiKey: null,
    body: { code },
  });
  expectStatus(exchanged, [200], "exchange code");
  const result = exchanged.json as { token: string; userId: string; version: string };
  expect(result.token.startsWith("aswt_"), "exchange returns an aswt_ token");
  expect(result.userId === userId, "exchange returns the code's user");
  expect(typeof result.version === "string" && result.version.length > 0, "exchange version");

  const replay = await ctx.api("POST", "/api/connector/exchange", {
    apiKey: null,
    body: { code },
  });
  expectStatus(replay, [404], "replayed code");
  expect(
    (replay.json as { error?: string }).error === "code_invalid",
    "replay answers code_invalid",
  );
  const malformed = await ctx.api("POST", "/api/connector/exchange", {
    apiKey: null,
    body: { code: "not-a-code" },
  });
  expectStatus(malformed, [404], "malformed code");
  expect(
    (malformed.json as { error?: string }).error === "code_invalid",
    "malformed answers code_invalid",
  );

  // The checks the connector's validateLink runs with the new token.
  const health = await ctx.api("GET", "/health", { apiKey: null });
  expectStatus(health, [200], "health");
  expect(
    (health.json as { version?: string }).version === result.version,
    "health and exchange report the same version",
  );
  const whoami = await ctx.api("GET", "/api/whoami", { apiKey: result.token });
  expectStatus(whoami, [200], "whoami with the exchanged token");
  const principal = whoami.json as { kind: string; user: { id: string } | null };
  expect(principal.kind === "user" && principal.user?.id === userId, "token resolves to the user");

  const client = new Client({ name: "agent-swarm-e2e-connector", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp-user`), {
      requestInit: { headers: { Authorization: `Bearer ${result.token}` } },
    }),
  );
  try {
    const { tools } = await client.listTools();
    expect(tools.length > 0, "/mcp-user lists tools for the exchanged token");
    ctx.log(`/mcp-user listed ${tools.length} tools`);
  } finally {
    await client.close();
  }

  // Last: the per-IP exchange limiter (capacity 10) answers 429 with Retry-After.
  let limited = false;
  for (let attempt = 0; attempt < 15 && !limited; attempt++) {
    const response = await ctx.api("POST", "/api/connector/exchange", {
      apiKey: null,
      body: { code: "x".repeat(43) },
    });
    expectStatus(response, [404, 429], "exchange under rate limit");
    limited = response.status === 429;
  }
  expect(limited, "exchange is rate limited per IP");
}
