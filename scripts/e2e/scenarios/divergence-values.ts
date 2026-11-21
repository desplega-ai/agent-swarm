// Locks how values round-trip through storage today, so another storage engine must give
// back the same bytes and types: JSON text (key order, unicode, emoji, nesting, empty
// containers), boolean flags (JSON true/false, never 1/0) and integers up to 2^53 - 1.
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerWorker } from "./core-helpers";

const MAX_SAFE = 9_007_199_254_740_991; // 2^53 - 1
const TWO_POW_52 = 4_503_599_627_370_496;

// Key order is deliberate: "b" before "a" must survive, as must nested order.
const DOCUMENT = {
  b: 1,
  a: 2,
  nested: {
    z: [1, "two", { deep: [true, false, null] }, -0.5, 1e21],
    y: { "key with space": "Grüße ñ 日本語", emoji: "😀🚀👩‍👩‍👧" },
  },
  empty: {},
  emptyList: [],
  quote: 'say "hi" \\ back\nslash',
  big: MAX_SAFE,
  float: 0.1 + 0.2,
};
const DOCUMENT_TEXT = JSON.stringify(DOCUMENT);

async function kvJson(ctx: ScenarioContext, agentId: string): Promise<void> {
  const key = `div-values-${ctx.nonce}`;
  const put = await ctx.api("PUT", `/api/kv/${key}`, { agentId, body: { value: DOCUMENT } });
  expectStatus(put, [200], "kv put document");
  expect(asRecord(put.json).valueType === "json", "kv document valueType");
  const get = await ctx.api("GET", `/api/kv/${key}`, { agentId });
  expectStatus(get, [200], "kv get document");
  // Byte-level: the response carries the document exactly as stored, in the same key order.
  expect(
    get.text.includes(`"value":${DOCUMENT_TEXT}`),
    `kv document text changed:\n  sent ${DOCUMENT_TEXT}\n  got  ${get.text}`,
  );
  expect(
    JSON.stringify(asRecord(get.json).value) === DOCUMENT_TEXT,
    "kv document did not round-trip",
  );
  const value = asRecord(asRecord(get.json).value);
  expect(Object.keys(value).join(",") === Object.keys(DOCUMENT).join(","), "kv key order");

  // A string that looks like JSON stays a string.
  const lookalike = '{"b":1,"a":2}';
  const str = await ctx.api("PUT", `/api/kv/${key}-s`, { agentId, body: { value: lookalike } });
  expectStatus(str, [200], "kv put JSON-like string");
  const strGet = await ctx.api("GET", `/api/kv/${key}-s`, { agentId });
  expect(asRecord(strGet.json).value === lookalike, "a JSON-like string came back parsed");

  // Scalars keep their JSON type.
  for (const [suffix, scalar] of [
    ["t", true],
    ["f", false],
    ["n", null],
    ["z", 0],
  ] as const) {
    const scalarPut = await ctx.api("PUT", `/api/kv/${key}-${suffix}`, {
      agentId,
      body: { value: scalar },
    });
    expectStatus(scalarPut, [200], `kv put ${String(scalar)}`);
    const scalarGet = await ctx.api("GET", `/api/kv/${key}-${suffix}`, { agentId });
    expectStatus(scalarGet, [200], `kv get ${String(scalar)}`);
    expect(
      scalarGet.text.includes(`"value":${JSON.stringify(scalar)},`),
      `kv ${String(scalar)} came back as ${scalarGet.text}`,
    );
  }

  // Integer KV values: exact at 2^53 - 1, and INCR refuses to leave the safe range.
  const counter = `${key}-i`;
  const top = await ctx.api("PUT", `/api/kv/${counter}`, {
    agentId,
    body: { value: MAX_SAFE - 1, valueType: "integer" },
  });
  expectStatus(top, [200], "kv put integer");
  const incr = await ctx.api("POST", `/api/kv/${counter}/incr`, { agentId, body: { by: 1 } });
  expectStatus(incr, [200], "kv incr to 2^53 - 1");
  expect(asRecord(incr.json).value === MAX_SAFE, `kv incr gave ${incr.text}`);
  expect(incr.text.includes(`"value":${MAX_SAFE},`), "kv incr text is not the exact integer");
  const overflow = await ctx.api("POST", `/api/kv/${counter}/incr`, { agentId, body: { by: 1 } });
  expectStatus(overflow, [400], "kv incr past 2^53 - 1");
  expect(
    asRecord(overflow.json).error === "INCR would overflow JS-safe integer range",
    `kv overflow error ${overflow.text}`,
  );
  const low = `${key}-l`;
  expectStatus(
    await ctx.api("PUT", `/api/kv/${low}`, {
      agentId,
      body: { value: -MAX_SAFE, valueType: "integer" },
    }),
    [200],
    "kv put negative integer",
  );
  const underflow = await ctx.api("POST", `/api/kv/${low}/incr`, { agentId, body: { by: -1 } });
  expectStatus(underflow, [400], "kv incr below -(2^53 - 1)");
  const lowGet = await ctx.api("GET", `/api/kv/${low}`, { agentId });
  expect(asRecord(lowGet.json).value === -MAX_SAFE, "a refused INCR changed the value");
  // INCR on a JSON-typed key is a type collision.
  const collision = await ctx.api("POST", `/api/kv/${key}/incr`, { agentId, body: { by: 1 } });
  expectStatus(collision, [409], "kv incr on a json value");
  expect(
    asRecord(collision.json).error === "Cannot INCR a key with value_type 'json'",
    `kv collision error ${collision.text}`,
  );

  for (const suffix of ["", "-s", "-t", "-f", "-n", "-z", "-i", "-l"]) {
    expectStatus(
      await ctx.api("DELETE", `/api/kv/${key}${suffix}`, { agentId }),
      [200, 204],
      "kv cleanup",
    );
  }
}

async function userMetadata(ctx: ScenarioContext): Promise<void> {
  const created = await ctx.api("POST", "/api/users", {
    body: { name: `Div values ${ctx.nonce}`, metadata: DOCUMENT },
  });
  expectStatus(created, [200], "create user with metadata");
  const userId = String(asRecord(asRecord(created.json).user).id);
  const read = await ctx.api("GET", `/api/users/${userId}`);
  expectStatus(read, [200], "read user");
  // users.metadata is jsonb on Postgres, which reorders object keys. Daniel approved
  // (2026-11-21) comparing the parsed value instead of the text for jsonb columns.
  // Every key and value must still match exactly.
  const metadata = asRecord(asRecord(read.json).user).metadata;
  expect(
    Bun.deepEquals(metadata, DOCUMENT, true),
    `user metadata value changed:\n  sent ${DOCUMENT_TEXT}\n  got  ${JSON.stringify(metadata)}`,
  );
}

async function booleans(ctx: ScenarioContext, agentId: string): Promise<void> {
  const agent = await ctx.api("GET", `/api/agents/${agentId}`);
  expectStatus(agent, [200], "read agent");
  expect(
    asRecord(agent.json).isLead === false,
    `agent isLead is ${String(asRecord(agent.json).isLead)}`,
  );

  const ids: string[] = [];
  for (const enabled of [true, false]) {
    const response = await ctx.api("POST", "/api/schedules", {
      body: {
        name: `div-values-${enabled}-${ctx.nonce}`,
        intervalMs: 86_400_000,
        taskTemplate: `div values ${ctx.nonce}`,
        targetAgentId: agentId,
        enabled,
      },
    });
    expectStatus(response, [201], `create schedule enabled=${enabled}`);
    expect(asRecord(response.json).enabled === enabled, "create returned another enabled flag");
    ids.push(String(asRecord(response.json).id));
  }
  const listed = await ctx.api("GET", `/api/schedules?name=div-values-&fields=full`);
  expectStatus(listed, [200], "list schedules");
  const mine = asRecords(listed.json, "schedules").filter((row) => ids.includes(String(row.id)));
  expect(mine.length === 2, "schedules missing from the list");
  for (const row of mine) {
    expect(typeof row.enabled === "boolean", `schedule enabled is ${typeof row.enabled}`);
    expect(typeof row.favorite === "boolean", `schedule favorite is ${typeof row.favorite}`);
  }
  // Flip through PUT and read back the boolean, not 0/1.
  const flip = await ctx.api("PUT", `/api/schedules/${ids[1]}`, { body: { enabled: true } });
  expectStatus(flip, [200], "enable schedule");
  const read = await ctx.api("GET", `/api/schedules/${ids[1]}`);
  expect(read.text.includes('"enabled":true'), `schedule enabled after PUT: ${read.text}`);
  for (const id of ids) {
    expectStatus(await ctx.api("DELETE", `/api/schedules/${id}`), [200, 204], "delete schedule");
  }

  const server = await ctx.api("POST", "/api/mcp-servers", {
    body: {
      name: `div-values-${ctx.nonce}`,
      transport: "http",
      url: "https://example.com/mcp",
    },
  });
  expectStatus(server, [201], "create mcp server");
  const record = asRecord(asRecord(server.json).server);
  expect(record.isEnabled === true, `mcp server isEnabled is ${String(record.isEnabled)}`);
  expectStatus(
    await ctx.api("DELETE", `/api/mcp-servers/${String(record.id)}`),
    [200, 204],
    "delete mcp server",
  );
}

async function sessionCostNumbers(ctx: ScenarioContext, agentId: string): Promise<void> {
  const body = {
    sessionId: `div-values-${ctx.nonce}`,
    agentId,
    totalCostUsd: 0.1234567890123,
    inputTokens: MAX_SAFE,
    outputTokens: TWO_POW_52,
    reasoningOutputTokens: MAX_SAFE - 1,
    durationMs: 9_007_199_254_740_000,
    model: `div-values-model-${ctx.nonce}`,
    isError: true,
  };
  const stored = await ctx.api("POST", "/api/session-costs", { body });
  expectStatus(stored, [201], "store session cost");
  const listed = await ctx.api("GET", `/api/session-costs?agentId=${agentId}`);
  expectStatus(listed, [200], "list session costs");
  const rows = asRecords(listed.json, "costs");
  expect(rows.length === 1, `expected one cost row, got ${rows.length}`);
  for (const response of [stored.text, listed.text]) {
    for (const fragment of [
      `"inputTokens":${MAX_SAFE},`,
      `"outputTokens":${TWO_POW_52},`,
      `"reasoningOutputTokens":${MAX_SAFE - 1},`,
      `"durationMs":9007199254740000,`,
      `"totalCostUsd":0.1234567890123,`,
      `"isError":true,`,
      `"cacheReadTokens":null,`,
    ]) {
      expect(response.includes(fragment), `session cost lacks ${fragment}: ${response}`);
    }
  }
}

export const divergenceValues: Scenario = {
  name: "divergence-values",
  order: 9_235,
  async run(ctx) {
    const agentId = await registerWorker(ctx, "div-values");
    await kvJson(ctx, agentId);
    await userMetadata(ctx);
    await booleans(ctx, agentId);
    await sessionCostNumbers(ctx, agentId);
  },
};
