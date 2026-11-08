import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { createServer, type Server } from "node:http";
import {
  type CreateSessionCostInput,
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  getDbClient,
  initDb,
  recordKeyRateLimitWindows,
  recordKeyUsage,
} from "../be/db";
import {
  KEY_WINDOW_USAGE_SQL,
  type KeyWindowUsage,
  keyWindowUsageSchema,
} from "../be/key-window-usage";
import { handleApiKeys } from "../http/api-keys";
import { clearUsageCache } from "../http/usage-cache";
import { codexWindowKey } from "../utils/provider-account-telemetry";
import { beginRequestAuthScope, setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const now = Date.parse("2026-11-08T12:00:00.000Z");
const start = new Date(now - 3_600_000).toISOString();
const end = (now + 3_600_000) / 1000;
const agentId = crypto.randomUUID();
const otherAgentId = crypto.randomUUID();
const keyType = "CODEX_OAUTH";
const windowKey = codexWindowKey("codex", "primary");
let server: Server;
let base: string;

beforeAll(async () => {
  initDb(":memory:");
  await createAgent({ id: agentId, name: "Usage A", isLead: false, status: "idle" });
  await createAgent({ id: otherAgentId, name: "Usage B", isLead: false, status: "idle" });
  server = createServer(async (req, res) => {
    beginRequestAuthScope();
    const caller = String(req.headers["x-caller"] ?? agentId);
    setRequestAuth(req, {
      kind: "agent",
      agentId: caller,
      taskId: null,
      runtimeId: null,
      tokenKind: "agent",
      tokenId: caller,
      expiresAt: new Date(now + 86400000).toISOString(),
    });
    const url = new URL(req.url!, "http://localhost");
    if (!(await handleApiKeys(req, res, url.pathname.split("/").filter(Boolean), url.searchParams)))
      res.writeHead(404).end();
  });
  base = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});
beforeEach(async () => {
  setSystemTime(now);
  clearUsageCache();
  await getDbClient().run("DELETE FROM session_costs");
  await getDbClient().run("DELETE FROM api_key_status");
});
afterEach(() => {
  setSystemTime();
  clearUsageCache();
});

async function quota(
  suffix = "key-a",
  windows = {
    [windowKey]: {
      status: "allowed",
      source: "codex" as const,
      limitId: "codex",
      durationMins: 120,
      resetsAt: end,
      lastSeenAt: new Date(now - 1000).toISOString(),
    },
  },
  scope = "global",
  scopeId: string | null = null,
) {
  await recordKeyRateLimitWindows(keyType, suffix, 0, windows, scope, scopeId);
}
async function cost(extra: Partial<CreateSessionCostInput> = {}, at = now - 1000) {
  const row = await createSessionCost({
    sessionId: crypto.randomUUID(),
    agentId,
    model: "gpt-6",
    harness: "codex",
    credentialKeyType: keyType,
    credentialKeySuffix: "key-a",
    totalCostUsd: 0,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 40,
    durationMs: 1000,
    numTurns: 1,
    ...extra,
  });
  await getDbClient().run("UPDATE session_costs SET createdAt = ? WHERE id = ?", [
    new Date(at).toISOString(),
    row.id,
  ]);
  return row;
}
async function read(query = "", caller = agentId) {
  const response = await fetch(`${base}/api/keys/window-usage${query}`, {
    headers: { "X-Caller": caller },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    asOf: string;
    accounting: string;
    windows: KeyWindowUsage[];
  };
  for (const window of body.windows) keyWindowUsageSchema.parse(window);
  return body;
}
async function completed(at = now - 1000) {
  const task = await createTaskExtended("Usage fixture", { agentId, source: "system" });
  await getDbClient().run(
    "UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?",
    [new Date(at).toISOString(), task.id],
  );
  return task.id;
}

test("normalizes mixed harness input without counting cache twice and retains missing counters", async () => {
  await quota();
  await cost({ reasoningOutputTokens: 8 });
  await cost({ harness: "pi", inputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 });
  await cost({
    harness: "opencode",
    inputTokens: 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    isError: true,
  });
  await cost({
    harness: "claude",
    inputTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 5,
    thinkingTokens: 4,
  });
  await cost({ harness: "codex", inputTokens: 300, cacheReadTokens: null });
  const result = await read();
  expect(result.accounting).toBe("session_cost_receipt_time");
  const window = result.windows[0]!;
  expect(window.startsAt).toBe(start);
  expect(window.endsAt).toBe(new Date(end * 1000).toISOString());
  expect(window.dataThrough).toBe(new Date(now).toISOString());
  expect(window.observationAgeMs).toBe(1000);
  expect(window.usage).toMatchObject({ sessions: 5, errorSessions: 1, completedTasks: 0 });
  expect(window.usage!.tokens.uncachedInput).toEqual({
    value: 160,
    measuredSessions: 4,
    missingSessions: 1,
  });
  expect(window.usage!.tokens.cacheRead).toEqual({
    value: 50,
    measuredSessions: 3,
    missingSessions: 2,
  });
  expect(window.usage!.tokens.cacheWrite).toEqual({
    value: 5,
    measuredSessions: 2,
    missingSessions: 3,
  });
  expect(window.usage!.tokens.reasoning).toEqual({
    value: 8,
    measuredSessions: 1,
    missingSessions: 4,
  });
  expect(window.usage!.tokens.thinking).toEqual({
    value: 4,
    measuredSessions: 1,
    missingSessions: 4,
  });
});

test("deduplicates retries per completed task and preserves both credential attributions", async () => {
  await quota();
  await quota("key-b");
  const taskId = await completed();
  await cost({ taskId, isError: true });
  await cost({ taskId });
  await cost({ taskId, credentialKeySuffix: "key-b" });
  await recordKeyUsage(keyType, "key-b", 1, taskId);
  const windows = (await read()).windows;
  expect(windows.find((w) => w.keySuffix === "key-a")!.usage).toMatchObject({
    sessions: 2,
    completedTasks: 1,
  });
  expect(windows.find((w) => w.keySuffix === "key-b")!.usage).toMatchObject({
    sessions: 1,
    completedTasks: 1,
  });
});

test("uses receipt time for delayed tokens and completion time for tasks with attributable sessions", async () => {
  await quota();
  const taskId = await completed(now - 3_600_001);
  await cost({ taskId, durationMs: 7_200_000 });
  const earlierSessionTask = await completed();
  await cost({ taskId: earlierSessionTask }, now - 3_600_001);
  const failed = await completed();
  await getDbClient().run("UPDATE agent_tasks SET status = 'failed' WHERE id = ?", [failed]);
  await cost({ taskId: failed });
  expect((await read()).windows[0]!.usage).toMatchObject({ sessions: 2, completedTasks: 1 });
});

test("uses half-open receipt and completion bounds", async () => {
  await quota();
  await cost({ taskId: await completed(now - 3_600_000) }, now - 3_600_000);
  await cost({ taskId: await completed(now) }, now);
  await cost({}, now - 3_600_001);
  expect((await read()).windows[0]!.usage).toMatchObject({ sessions: 1, completedTasks: 1 });
});

test("uses matching model breakdowns and leaves session reasoning unallocated", async () => {
  await recordKeyRateLimitWindows("CLAUDE_CODE_OAUTH_TOKEN", "key-a", 0, {
    seven_day_opus: {
      status: "allowed",
      source: "claude",
      resetsAt: end,
      lastSeenAt: new Date(now).toISOString(),
    },
  });
  await cost({
    credentialKeyType: "CLAUDE_CODE_OAUTH_TOKEN",
    harness: "claude",
    inputTokens: 900,
    reasoningOutputTokens: 200,
    model: "claude-sonnet-4-5",
    modelBreakdown: [
      {
        model: "claude-opus-4-7",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
      },
      {
        model: "claude-sonnet-4-5",
        inputTokens: 800,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
  });
  await cost({
    credentialKeyType: "CLAUDE_CODE_OAUTH_TOKEN",
    harness: "claude",
    model: "",
    inputTokens: 1000,
  });
  const usage = (await read()).windows[0]!.usage!;
  expect(usage.sessions).toBe(1);
  expect(usage.tokens.uncachedInput.value).toBe(100);
  expect(usage.tokens.output.value).toBe(20);
  expect(usage.tokens.reasoning.value).toBeNull();
  expect(usage.modelUnattributedSessions).toBe(1);
});

test("reuses legacy Claude family and duration rules without guessing labels", async () => {
  await recordKeyRateLimitWindows("CLAUDE_CODE_OAUTH_TOKEN", "claude", 0, {
    seven_day_opus: { status: "allowed", resetsAt: end, lastSeenAt: new Date(now).toISOString() },
  });
  await cost({
    credentialKeyType: "CLAUDE_CODE_OAUTH_TOKEN",
    credentialKeySuffix: "claude",
    harness: "claude",
    model: "claude-opus-4-7",
    modelBreakdown: [
      {
        model: "claude-opus-4-7",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
  });
  await cost({
    credentialKeyType: "CLAUDE_CODE_OAUTH_TOKEN",
    credentialKeySuffix: "claude",
    harness: "claude",
    model: "claude-sonnet-4-5",
    modelBreakdown: [
      {
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
  });
  const window = (await read()).windows[0]!;
  expect(window.durationMins).toBe(10080);
  expect(window.modelScope).toEqual({ kind: "family", model: "opus" });
  expect(window.usage!.sessions).toBe(1);
});

test("reports unknown durations, resets, and model scopes as unavailable", async () => {
  await quota("key-a", {
    [windowKey]: {
      status: "allowed",
      source: "codex",
      resetsAt: end,
      lastSeenAt: new Date(now).toISOString(),
    },
    missing: { status: "allowed", durationMins: 120, lastSeenAt: new Date(now).toISOString() },
    scoped: {
      status: "allowed",
      durationMins: 120,
      resetsAt: end,
      label: "gpt-6 weekly",
      lastSeenAt: new Date(now).toISOString(),
    },
  } as Parameters<typeof recordKeyRateLimitWindows>[3]);
  const windows = (await read()).windows;
  expect(windows.map((w) => w.unavailableReason).sort()).toEqual([
    "missing_reset",
    "unknown_duration",
    "unknown_model_scope",
  ]);
  expect(windows.every((w) => w.usage === null)).toBe(true);
});

test("does not assign historical unknown credentials to one key or guess unknown harness input", async () => {
  await quota();
  await quota("key-b");
  await cost({ credentialKeyType: null, credentialKeySuffix: null });
  await cost({ harness: null });
  const windows = (await read("?keyType=CODEX_OAUTH&keySuffix=key-a")).windows;
  expect(windows).toHaveLength(1);
  expect(windows[0]!.usage).toMatchObject({ sessions: 1, swarmUnattributedSessions: 1 });
  expect(windows[0]!.usage!.tokens.uncachedInput).toEqual({
    value: null,
    measuredSessions: 0,
    missingSessions: 1,
  });
});

test("filters retain separate populations while callers share the same visible cache", async () => {
  await quota();
  await quota("key-b");
  await quota("key-a", undefined, "agent", agentId);
  await cost();
  expect((await read("?scope=global&keySuffix=key-b")).windows[0]!.usage!.sessions).toBe(0);
  expect((await read(`?scope=agent&scopeId=${agentId}`)).windows).toHaveLength(1);
  expect((await read(`?scope=agent&scopeId=${otherAgentId}`)).windows).toHaveLength(0);
  const first = await read("?scope=global&keySuffix=key-a");
  await cost();
  expect((await read("?scope=global&keySuffix=key-a")).windows[0]!.usage!.sessions).toBe(1);
  expect(
    (await read("?scope=global&keySuffix=key-a", otherAgentId)).windows[0]!.usage!.sessions,
  ).toBe(1);
  expect(first.windows[0]!.scope).toBe("global");
});

test("hides windows at reset even when their expensive usage result remains cached", async () => {
  await quota();
  await cost();
  expect((await read()).windows).toHaveLength(1);
  // Move the reset inside the fresh cache interval, then cache that result.
  await quota("key-a", {
    [windowKey]: {
      status: "allowed",
      source: "codex",
      limitId: "codex",
      durationMins: 120,
      resetsAt: now / 1000 + 1,
      lastSeenAt: new Date(now).toISOString(),
    },
  });
  expect((await read()).windows).toHaveLength(1);
  setSystemTime(now + 1000);
  expect((await read()).windows).toHaveLength(0);
});

test("keeps overlapping windows independent and removes tombstoned slots during cache freshness", async () => {
  const secondary = codexWindowKey("codex", "secondary");
  await quota("key-a", {
    [windowKey]: {
      status: "allowed",
      source: "codex",
      limitId: "codex",
      durationMins: 120,
      resetsAt: end,
      lastSeenAt: new Date(now).toISOString(),
    },
    [secondary]: {
      status: "allowed",
      source: "codex",
      limitId: "codex",
      durationMins: 10080,
      resetsAt: end,
      lastSeenAt: new Date(now).toISOString(),
    },
  });
  await cost();
  expect((await read()).windows.map((w) => w.usage!.sessions)).toEqual([1, 1]);
  await recordKeyRateLimitWindows(keyType, "key-a", 0, {}, "global", null, undefined, [
    {
      source: "codex",
      limitId: "codex",
      slots: ["primary"],
      observedAt: new Date(now).toISOString(),
    },
  ]);
  expect((await read()).windows.map((w) => w.windowKey)).toEqual([secondary]);
});

test("batches all windows and inspects credential and receipt index plans", async () => {
  await quota();
  await quota("key-b");
  await cost();
  const client = getDbClient();
  const query = spyOn(client, "query");
  await read();
  expect(query.mock.calls.filter(([sql]) => sql === KEY_WINDOW_USAGE_SQL)).toHaveLength(1);
  query.mockRestore();
  const plan = await client.query<{ detail: string }>(
    `EXPLAIN QUERY PLAN ${KEY_WINDOW_USAGE_SQL}`,
    [
      JSON.stringify([{ keyType, keySuffix: "key-a" }]),
      start,
      new Date(now).toISOString(),
      start,
      new Date(now).toISOString(),
      start,
      start,
      new Date(now).toISOString(),
    ],
  );
  const details = plan.map((row) => row.detail).join("\n");
  const credentialScans = plan.filter((row) =>
    row.detail.includes("idx_session_costs_credential_createdAt"),
  );
  expect(credentialScans.length).toBeGreaterThan(0);
  for (const scan of credentialScans) expect(scan.detail).toContain("createdAt>? AND createdAt<?");
  expect(details).toContain(
    "idx_agent_tasks_status_finishedAt (status=? AND finishedAt>? AND finishedAt<?)",
  );
  expect(details).toContain("idx_session_costs_taskId (taskId=?)");
  expect(details).toContain("idx_session_costs_createdAt");
});

test("returns a controlled error when an uncached query fails", async () => {
  const client = getDbClient();
  const query = spyOn(client, "query").mockRejectedValueOnce(
    new Error("fixture database unavailable"),
  );
  try {
    const response = await fetch(`${base}/api/keys/window-usage`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "fixture database unavailable" });
  } finally {
    query.mockRestore();
  }
});

test("keeps default Codex limits account-wide despite an account display slug", async () => {
  await recordKeyRateLimitWindows(
    keyType,
    "key-a",
    0,
    {
      [windowKey]: {
        status: "allowed",
        source: "codex",
        limitId: "codex",
        durationMins: 120,
        resetsAt: end,
        lastSeenAt: new Date(now).toISOString(),
      },
    },
    "global",
    null,
    {
      source: "codex",
      observedAt: new Date(now).toISOString(),
      limits: {
        codex: { observedAt: new Date(now - 1000).toISOString(), normalModelSlug: "gpt-6" },
      },
    },
  );
  await cost({ model: "gpt-other" });
  await cost({ harness: "pi", model: "openai-codex/gpt-6-mini" });
  const window = (await read()).windows[0]!;
  expect(window.modelScope).toEqual({ kind: "account", model: null });
  expect(window.usage!.sessions).toBe(2);
});

test("does not infer alias model scope from window or account display slugs", async () => {
  const alias = "codex-model-alias";
  await recordKeyRateLimitWindows(
    keyType,
    "key-a",
    0,
    {
      [codexWindowKey(alias, "primary")]: {
        status: "allowed",
        source: "codex",
        limitId: alias,
        durationMins: 120,
        resetsAt: end,
        normalModelSlug: "gpt-old",
        lastSeenAt: new Date(now).toISOString(),
        fieldObservedAt: { normalModelSlug: new Date(now - 3000).toISOString() },
      },
    },
    "global",
    null,
    {
      source: "codex",
      observedAt: new Date(now).toISOString(),
      limits: {
        [alias]: {
          observedAt: new Date(now - 2000).toISOString(),
          normalModelSlug: "gpt-6",
          fieldObservedAt: { normalModelSlug: new Date(now - 2000).toISOString() },
        },
      },
    },
  );
  const window = (await read()).windows[0]!;
  expect(window.modelScope).toEqual({ kind: "unknown", model: null });
  expect(window.unavailableReason).toBe("unknown_model_scope");
  expect(window.usage).toBeNull();
});

test("filters expiry after an in-flight aggregation crosses reset", async () => {
  await quota("key-a", {
    [windowKey]: {
      status: "allowed",
      source: "codex",
      limitId: "codex",
      durationMins: 120,
      resetsAt: now / 1000 + 1,
      lastSeenAt: new Date(now).toISOString(),
    },
  });
  await cost();
  const client = getDbClient();
  const original = client.query.bind(client);
  const query = spyOn(client, "query").mockImplementation(async (sql, params) => {
    const rows = await original(sql, params);
    if (sql === KEY_WINDOW_USAGE_SQL) setSystemTime(now + 1000);
    return rows;
  });
  try {
    expect((await read()).windows).toHaveLength(0);
  } finally {
    query.mockRestore();
  }
});

test("keeps default Codex limits account-wide despite a window display slug", async () => {
  await quota("key-a", {
    [windowKey]: {
      status: "allowed",
      source: "codex",
      limitId: "codex",
      durationMins: 120,
      resetsAt: end,
      lastSeenAt: new Date(now).toISOString(),
      normalModelSlug: "gpt-6",
    },
  } as Parameters<typeof recordKeyRateLimitWindows>[3]);
  await cost();
  await cost({ harness: "pi", model: "openai-codex/gpt-6-mini" });
  const window = (await read()).windows[0]!;
  expect(window.modelScope).toEqual({ kind: "account", model: null });
  expect(window.usage!.sessions).toBe(2);
});

test("does not assign mixed-model sessions without breakdowns to a Claude family", async () => {
  await recordKeyRateLimitWindows("CLAUDE_CODE_OAUTH_TOKEN", "claude", 0, {
    seven_day_opus: { status: "allowed", resetsAt: end, lastSeenAt: new Date(now).toISOString() },
  });
  for (const harness of ["claude", "claude-managed", "pi", "opencode"] as const) {
    await cost({
      credentialKeyType: "CLAUDE_CODE_OAUTH_TOKEN",
      credentialKeySuffix: "claude",
      model: "claude-opus-4-7",
      harness,
      taskId: await completed(),
    });
  }
  const usage = (await read()).windows[0]!.usage!;
  expect(usage.sessions).toBe(0);
  expect(usage.completedTasks).toBe(0);
  expect(usage.modelUnattributedSessions).toBe(4);
  expect(usage.tokens.uncachedInput.value).toBeNull();
});

test("scope rows preserve separate identities without multiplying per-window usage", async () => {
  await quota();
  await quota("key-a", undefined, "agent", agentId);
  await cost();
  const windows = (await read()).windows;
  expect(windows).toHaveLength(2);
  expect(new Set(windows.map((window) => window.statusId)).size).toBe(2);
  expect(windows.map((window) => window.usage!.sessions)).toEqual([1, 1]);
});

test("keeps cached data bounds while quota observations advance", async () => {
  await quota();
  await cost();
  const first = (await read()).windows[0]!;
  setSystemTime(now + 1000);
  await cost({}, now + 500);
  const response = await fetch(`${base}/api/keys/report-rate-limit-windows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keyType,
      keySuffix: "key-a",
      keyIndex: 0,
      windows: {
        [windowKey]: {
          source: "codex",
          status: "allowed",
          utilization: 0.4,
          limitId: "codex",
          lastSeenAt: new Date(now + 500).toISOString(),
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  const second = (await read()).windows[0]!;
  expect(second.dataThrough).toBe(first.dataThrough);
  expect(second.usage!.sessions).toBe(1);
  expect(second.observedAt).toBe(new Date(now + 500).toISOString());
  expect(second.observationAgeMs).toBe(500);
});
