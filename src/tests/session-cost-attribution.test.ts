import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  getDbClient,
  getKeyCostSummary,
  getSessionCostSummary,
  initDb,
  insertActiveSession,
  recordKeyUsage,
  setApiKeyPlan,
} from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import {
  mintAgentToken,
  mintRuntimeToken,
  mintScriptRunToken,
  mintSessionToken,
} from "../be/users";
import { spawnProviderProcess } from "../commands/runner";
import { handleApiKeys } from "../http/api-keys";
import { handleCore } from "../http/core";
import { handleSessionData } from "../http/session-data";
import { resolveCodexAuthMode } from "../providers/codex-adapter";
import type { CostData, ProviderEvent, ProviderSessionConfig } from "../providers/types";
import { getServerSessionsProcessed } from "../server-runtime-counters";
import { listenOnFreePort } from "./test-net";

const key = "example-phase2-session-attribution";
const agentId = crypto.randomUUID();
const otherAgentId = crypto.randomUUID();
let taskId: string;
let runtimeToken: string;
let taskToken: string;
let poolSlot: number | null = 1;
let server: Server;
let base: string;
beforeAll(async () => {
  initDb(":memory:");
  await createAgent({ id: agentId, name: "Attribution worker", isLead: false, status: "idle" });
  await createAgent({ id: otherAgentId, name: "Other worker", isLead: false, status: "idle" });
  taskId = (await createTaskExtended("Attribution retry", { agentId, source: "system" })).id;
  runtimeToken = (await mintRuntimeToken(agentId, crypto.randomUUID())).plaintext;
  taskToken = (await mintSessionToken(agentId, taskId, 60_000)).plaintext;
  server = createServer(async (req, res) => {
    const agent = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, agent, key)) return;
    if (req.url?.startsWith("/api/config/resolved")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          configs:
            poolSlot === null
              ? []
              : [
                  {
                    key: `codex_oauth_${poolSlot}`,
                    value: JSON.stringify({
                      access: `fixture-access-${poolSlot}`,
                      refresh: "fixture-refresh",
                      expires: Date.now() + 86400000,
                      accountId: `fixture-account-${poolSlot}`,
                    }),
                  },
                ],
        }),
      );
      return;
    }
    if (
      await handleApiKeys(
        req,
        res,
        (req.url ?? "").split("?")[0]!.split("/").filter(Boolean),
        new URLSearchParams((req.url ?? "").split("?")[1]),
      )
    )
      return;
    if (
      await handleSessionData(
        req,
        res,
        (req.url ?? "").split("?")[0]!.split("/").filter(Boolean),
        new URLSearchParams(),
        agent,
      )
    )
      return;
    res.writeHead(404).end();
  });
  base = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});
function body(extra: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    taskId,
    agentId,
    totalCostUsd: 1,
    inputTokens: 100,
    outputTokens: 20,
    model: "gpt-5",
    provider: "codex",
    ...extra,
  };
}
async function post(value: Record<string, unknown>, bearer = runtimeToken) {
  const response = await fetch(`${base}/api/session-costs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "X-Agent-ID": agentId,
    },
    body: JSON.stringify(value),
  });
  return {
    status: response.status,
    data: (await response.json()) as { cost: Record<string, unknown> },
  };
}

test("delayed reports, retries and resumes retain execution credentials and harness semantics", async () => {
  await recordKeyUsage("CODEX_OAUTH", "cred-A", 0, taskId);
  const a = body({
    credentialKeyType: "CODEX_OAUTH",
    credentialKeySuffix: "cred-A",
    harness: "codex",
    cacheReadTokens: 40,
  });
  await recordKeyUsage("CODEX_OAUTH", "cred-B", 1, taskId);
  const b = body({
    credentialKeyType: "CODEX_OAUTH",
    credentialKeySuffix: "cred-B",
    harness: "pi",
    provider: "pi",
    cacheReadTokens: 40,
    isError: true,
  });
  const savedB = await post(b);
  const savedA = await post(a);
  expect(savedB.status).toBe(201);
  expect(savedA.status).toBe(201);
  expect(savedA.data.cost).toMatchObject({
    credentialKeySuffix: "cred-A",
    harness: "codex",
    inputTokens: 100,
    cacheReadTokens: 40,
    cacheWriteTokens: null,
  });
  expect(savedB.data.cost).toMatchObject({
    credentialKeySuffix: "cred-B",
    harness: "pi",
    inputTokens: 100,
    cacheReadTokens: 40,
  });
  const resumed = await post(
    body({ credentialKeyType: "CODEX_OAUTH", credentialKeySuffix: "cred-B", harness: "codex" }),
  );
  expect(resumed.status).toBe(201);
  expect(resumed.data.cost).toMatchObject({
    credentialKeySuffix: "cred-B",
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  const summary = await getSessionCostSummary({ agentId, groupBy: "both" });
  expect(summary.byCredential.find((row) => row.keySuffix === "cred-A")?.sessions).toBe(1);
  expect(summary.byCredential.find((row) => row.keySuffix === "cred-B")?.sessions).toBe(2);
  expect(
    (await getKeyCostSummary("CODEX_OAUTH")).find((row) => row.keySuffix === "cred-A")
      ?.totalInputTokens,
  ).toBe(100);
});

test("concurrent reposts do not duplicate counters or rewrite attribution", async () => {
  const value = body({
    credentialKeyType: "CODEX_OAUTH",
    credentialKeySuffix: "first",
    harness: "codex",
  });
  const before = getServerSessionsProcessed();
  const first = await post(value);
  const repeats = await Promise.all(
    Array.from({ length: 4 }, () =>
      post({
        ...value,
        id: crypto.randomUUID(),
        inputTokens: 999,
        credentialKeySuffix: "other",
        harness: "pi",
      }),
    ),
  );
  for (const repeat of repeats) {
    expect(repeat.status).toBe(201);
    expect(repeat.data.cost).toEqual(first.data.cost);
  }
  expect(getServerSessionsProcessed() - before).toBe(1);
  expect(
    await getDbClient().get("SELECT COUNT(*) AS n FROM session_costs WHERE sessionId = ?", [
      String(value.sessionId),
    ]),
  ).toEqual({ n: 1 });
});

test("record and session identities cannot be reassigned", async () => {
  const value = body();
  expect((await post(value)).status).toBe(201);
  expect((await post({ ...value, sessionId: crypto.randomUUID() })).status).toBe(409);
  expect((await post({ ...value, taskId: undefined })).status).toBe(409);
  expect((await post({ ...value, agentId: otherAgentId }, key)).status).toBe(409);
});

test("legacy reports stay unattributed, including a later attempted upgrade", async () => {
  const value = body();
  const first = await post(value, taskToken);
  expect(first.status).toBe(201);
  expect(first.data.cost).toMatchObject({
    credentialKeyType: null,
    credentialKeySuffix: null,
    harness: null,
  });
  expect(
    (
      await post({
        ...value,
        credentialKeyType: "CODEX_OAUTH",
        credentialKeySuffix: "later",
        harness: "codex",
      })
    ).data.cost,
  ).toEqual(first.data.cost);
});

test("task tokens cannot assert session attribution or a different agent", async () => {
  expect(
    (
      await post(
        body({ credentialKeyType: "CODEX_OAUTH", credentialKeySuffix: "forged", harness: "codex" }),
        taskToken,
      )
    ).status,
  ).toBe(403);
  expect((await post(body({ agentId: otherAgentId }))).status).toBe(403);
  expect((await post(body({ credentialKeyType: "CODEX_OAUTH" }))).status).toBe(400);
});

test("estimated plan records remain uncertain in savings summaries", async () => {
  await recordKeyUsage("CLAUDE_CODE_OAUTH_TOKEN", "estimate", 0, taskId);
  await getDbClient().run(
    "UPDATE api_key_status SET plan = 'claude_max_5x', planSource = 'estimated' WHERE keySuffix = 'estimate'",
  );
  await createSessionCost({
    sessionId: crypto.randomUUID(),
    agentId,
    taskId,
    totalCostUsd: 1,
    durationMs: 1,
    numTurns: 1,
    model: "opus",
    credentialKeyType: "CLAUDE_CODE_OAUTH_TOKEN",
    credentialKeySuffix: "estimate",
    harness: "claude",
  });
  const summary = await getSessionCostSummary({ agentId, groupBy: "both" });
  expect(summary.byCredential.find((row) => row.keySuffix === "estimate")).toMatchObject({
    plan: null,
    planSource: "estimated",
  });
  expect(
    await getDbClient().get("SELECT plan FROM api_key_status WHERE keySuffix = 'estimate'"),
  ).toEqual({ plan: "claude_max_5x" });
});

test("ambiguous raw Pro detection preserves manual selection and invalidates stale savings", async () => {
  await recordKeyUsage("CODEX_OAUTH", "rawpro", 0, null, "global", null, "chatgpt_plus");
  await recordKeyUsage("CODEX_OAUTH", "rawpro", 0, null, "global", null, null, "promax");
  expect(
    await getDbClient().get(
      "SELECT plan, detectedPlanRaw FROM api_key_status WHERE keySuffix = 'rawpro'",
    ),
  ).toEqual({ plan: null, detectedPlanRaw: "promax" });
  await setApiKeyPlan("CODEX_OAUTH", "rawpro", "chatgpt_pro_500");
  await recordKeyUsage("CODEX_OAUTH", "rawpro", 0, null, "global", null, "chatgpt_pro", "prolite");
  expect(
    await getDbClient().get(
      "SELECT plan, planSource, detectedPlanRaw FROM api_key_status WHERE keySuffix = 'rawpro'",
    ),
  ).toEqual({ plan: "chatgpt_pro_500", planSource: "manual", detectedPlanRaw: "prolite" });
});

test("migration 307 preserves existing rows, manual plans, and null historical attribution", async () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    expect(
      db.query("SELECT credentialKeyType, harness, cacheReadTokens FROM session_costs").all(),
    ).toEqual([]);
    // Restore the pre-307 column shape, then migrate an existing database.
    db.run("DROP INDEX idx_session_costs_credential_createdAt");
    db.run("DROP INDEX idx_session_costs_sessionId");
    for (const column of ["credentialKeyType", "credentialKeySuffix", "harness"])
      db.run(`ALTER TABLE session_costs DROP COLUMN ${column}`);
    db.run("ALTER TABLE api_key_status DROP COLUMN detectedPlanRaw");
    db.run("ALTER TABLE session_costs RENAME COLUMN cacheReadTokens TO priorCacheReadTokens");
    db.run("ALTER TABLE session_costs ADD COLUMN cacheReadTokens INTEGER NOT NULL DEFAULT 0");
    db.run("ALTER TABLE session_costs DROP COLUMN priorCacheReadTokens");
    db.run("DELETE FROM _migrations WHERE version = 307");
    db.run("PRAGMA foreign_keys = OFF");
    db.run(
      "INSERT INTO session_costs(id, sessionId, agentId, totalCostUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, durationMs, numTurns, model, createdAt) VALUES ('old', 'old-session', 'old-agent', 7, 123, 12, 40, NULL, 100, 1, 'gpt-5', '2026-11-01T00:00:00.000Z')",
    );
    for (const source of ["manual", "detected", "estimated"])
      db.run(
        "INSERT INTO api_key_status(keyType, keySuffix, keyIndex, scope, scopeId, plan, planSource, updatedAt) VALUES ('CODEX_OAUTH', ?, 0, 'global', '', 'chatgpt_pro', ?, '2026-11-01T00:00:00.000Z')",
        [source, source],
      );
    for (const plan of ["chatgpt_pro_5x", "chatgpt_pro_500", "chatgpt_plus"])
      db.run(
        "INSERT INTO api_key_status(keyType, keySuffix, keyIndex, scope, scopeId, plan, planSource, updatedAt) VALUES ('CODEX_OAUTH', ?, 0, 'global', '', ?, 'detected', '2026-11-01T00:00:00.000Z')",
        [plan, plan],
      );
    runMigrations(db);
    runMigrations(db);
    expect(
      db
        .query(
          "SELECT totalCostUsd, inputTokens, cacheReadTokens, cacheWriteTokens, credentialKeyType, credentialKeySuffix, harness FROM session_costs",
        )
        .get(),
    ).toEqual({
      totalCostUsd: 7,
      inputTokens: 123,
      cacheReadTokens: 40,
      cacheWriteTokens: null,
      credentialKeyType: null,
      credentialKeySuffix: null,
      harness: null,
    });
    expect(db.query("SELECT plan FROM api_key_status WHERE keySuffix = 'manual'").get()).toEqual({
      plan: "chatgpt_pro",
    });
    expect(
      db
        .query("SELECT plan, detectedPlanRaw FROM api_key_status WHERE keySuffix = 'detected'")
        .get(),
    ).toEqual({ plan: null, detectedPlanRaw: "pro" });
    for (const plan of ["chatgpt_pro_5x", "chatgpt_pro_500", "chatgpt_plus"])
      expect(
        db
          .query("SELECT plan, planSource, detectedPlanRaw FROM api_key_status WHERE keySuffix = ?")
          .get(plan),
      ).toEqual({ plan, planSource: "detected", detectedPlanRaw: null });
    expect(
      db
        .query(
          "SELECT name FROM pragma_index_list('session_costs') WHERE name = 'idx_session_costs_credential_createdAt'",
        )
        .get(),
    ).not.toBeNull();
    expect(
      db
        .query(
          "SELECT [notnull] FROM pragma_table_info('session_costs') WHERE name = 'cacheReadTokens'",
        )
        .get(),
    ).toEqual({ notnull: 0 });
  } finally {
    db.close();
  }
});

test("the worker captures each Pi credential before delayed completion and resume", async () => {
  const directory = `/tmp/provider-usage-phase2-worker-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${directory}`.quiet();
  const completions: Array<() => void> = [];
  const slots: Array<number | undefined> = [];
  const adapter = {
    name: "pi",
    traits: {},
    async createSession(config: ProviderSessionConfig) {
      slots.push(config.codexSlot);
      let complete!: () => void;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      completions.push(complete);
      const cost: CostData = {
        sessionId: "native-history",
        agentId,
        totalCostUsd: 0,
        inputTokens: 100,
        cacheReadTokens: 40,
        outputTokens: 20,
        durationMs: 1,
        numTurns: 1,
        model: "gpt-5.6-sol",
        isError: false,
        provider: "pi",
      };
      return {
        sessionId: "native-history",
        onEvent(listener: (event: ProviderEvent) => void) {
          listener({ type: "result", cost, isError: false });
        },
        async waitForCompletion() {
          await completion;
          return { exitCode: 0, isError: false, cost };
        },
        async abort() {
          complete();
        },
      };
    },
  } as unknown as Parameters<typeof spawnProviderProcess>[0];
  const options = {
    prompt: "fixture",
    systemPrompt: "fixture",
    logFile: `${directory}/session.jsonl`,
    role: "worker",
    apiUrl: base,
    apiKey: runtimeToken,
    agentId,
    iteration: 1,
    taskId,
    model: "openai-codex/gpt-5.6-sol",
    harnessProvider: "pi" as const,
    cwd: directory,
  };
  try {
    poolSlot = 1;
    const first = await spawnProviderProcess(
      adapter,
      { ...options, runnerSessionId: crypto.randomUUID() },
      directory,
    );
    const captured = { ...first.lastCost?.value };
    poolSlot = 2;
    const resumed = await spawnProviderProcess(
      adapter,
      { ...options, runnerSessionId: crypto.randomUUID(), resumeSessionId: "native-history" },
      directory,
    );
    completions[1]!();
    await resumed.promise;
    completions[0]!();
    await first.promise;
    expect(slots).toEqual([1, 2]);
    expect(first.result?.cost).toMatchObject({
      ...captured,
      credentialKeyType: "CODEX_OAUTH",
      harness: "pi",
      inputTokens: 100,
      cacheReadTokens: 40,
    });
    expect(first.result?.cost?.credentialKeySuffix).not.toBe(
      resumed.result?.cost?.credentialKeySuffix,
    );
    expect(first.result?.cost?.sessionId).not.toBe(resumed.result?.cost?.sessionId);
    for (const running of [resumed, first]) {
      const saved = await post(running.result!.cost! as unknown as Record<string, unknown>);
      expect(saved.status).toBe(201);
      expect(saved.data.cost.credentialKeySuffix).toBe(running.result?.cost?.credentialKeySuffix);
      expect(saved.data.cost.harness).toBe("pi");
    }
  } finally {
    for (const complete of completions) complete();
    await Bun.$`rm -rf ${directory}`.quiet();
  }
});

test.each([
  "chatgpt",
  "apikey",
] as const)("Codex %s authentication determines cost attribution with an OpenAI API key", async (authMode) => {
  const directory = `/tmp/provider-usage-standalone-${crypto.randomUUID()}`;
  const envKeys = [
    "HOME",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "CODEX_PATH_OVERRIDE",
    "CODEX_GATEWAY_BASE_URL",
    "CODEX_GATEWAY_API_KEY",
  ] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const previousSlot = poolSlot;
  await Bun.write(
    `${directory}/.codex/auth.json`,
    JSON.stringify({
      auth_mode: authMode,
      tokens: {
        account_id: "acct-standalone",
        access_token: "fixture-access-standalone",
        refresh_token: "fixture-refresh-standalone",
        id_token: "fixture-id-standalone",
      },
    }),
  );
  const cost: CostData = {
    sessionId: "standalone-native",
    agentId,
    totalCostUsd: 1,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 1,
    numTurns: 1,
    model: "gpt-5.6-sol",
    isError: false,
    provider: "codex",
  };
  const adapter = {
    name: "codex",
    traits: {},
    async createSession(config: ProviderSessionConfig) {
      expect(config.env?.OPENAI_API_KEY).toBe("fixture-openai-key");
      expect(config.codexSlot).toBeUndefined();
      expect(await resolveCodexAuthMode(config, () => {})).toBe(authMode);
      return {
        sessionId: cost.sessionId,
        onEvent(listener: (event: ProviderEvent) => void) {
          listener({ type: "result", cost, isError: false });
        },
        async waitForCompletion() {
          return { exitCode: 0, isError: false, cost };
        },
        async abort() {},
      };
    },
  } as unknown as Parameters<typeof spawnProviderProcess>[0];
  try {
    poolSlot = null;
    process.env.HOME = directory;
    process.env.CODEX_HOME = `${directory}/.codex`;
    process.env.OPENAI_API_KEY = "fixture-openai-key";
    process.env.CODEX_PATH_OVERRIDE = process.execPath;
    delete process.env.CODEX_GATEWAY_BASE_URL;
    delete process.env.CODEX_GATEWAY_API_KEY;
    const running = await spawnProviderProcess(
      adapter,
      {
        prompt: "fixture",
        systemPrompt: "fixture",
        logFile: `${directory}/session.jsonl`,
        role: "worker",
        apiUrl: base,
        apiKey: runtimeToken,
        agentId,
        runnerSessionId: crypto.randomUUID(),
        iteration: 1,
        taskId,
        model: cost.model,
        harnessProvider: "codex",
        cwd: directory,
      },
      directory,
    );
    await running.promise;
    const expected =
      authMode === "chatgpt"
        ? { credentialKeyType: "CODEX_OAUTH", credentialKeySuffix: "alone-0" }
        : { credentialKeyType: "OPENAI_API_KEY", credentialKeySuffix: "i-key" };
    expect(running.lastCost?.value).toMatchObject(expected);
    expect(running.result?.cost).toMatchObject(expected);
    const saved = await post(running.result!.cost! as unknown as Record<string, unknown>);
    expect(saved.status).toBe(201);
    expect(saved.data.cost).toMatchObject(expected);
  } finally {
    poolSlot = previousSlot;
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Bun.$`rm -r ${directory}`.quiet();
  }
});

test("agent-bound worker tokens can report attribution, but script tokens cannot", async () => {
  const worker = await mintAgentToken(agentId);
  const script = await mintScriptRunToken(agentId, 60_000);
  const value = body({
    credentialKeyType: "CODEX_OAUTH",
    credentialKeySuffix: "worker",
    harness: "pi",
  });
  expect((await post(value, script.plaintext)).status).toBe(403);
  const saved = await post(value, worker.plaintext);
  expect(saved.status).toBe(201);
  expect(saved.data.cost).toMatchObject({ credentialKeySuffix: "worker", harness: "pi" });
});

test("a caller cannot claim another active execution before its first cost report", async () => {
  const sessionId = crypto.randomUUID();
  await insertActiveSession({
    agentId: otherAgentId,
    triggerType: "task_assigned",
    runnerSessionId: sessionId,
  });
  expect((await post(body({ sessionId }))).status).toBe(409);
});

test("taskless lead sessions retain costs while their synthetic task ID is active", async () => {
  for (const triggerType of ["channel_activity", "unread_mentions"] as const) {
    const sessionId = crypto.randomUUID();
    await insertActiveSession({
      agentId,
      taskId: crypto.randomUUID(),
      triggerType,
      runnerSessionId: sessionId,
    });
    const result = await post(body({ sessionId, taskId: undefined }));
    expect(result.status).toBe(201);
    expect(result.data.cost.taskId).toBeUndefined();
    expect(
      await getDbClient().get("SELECT taskId FROM session_costs WHERE sessionId = ?", [sessionId]),
    ).toEqual({ taskId: null });
  }
});

test("an active execution with a real task cannot omit or change that task", async () => {
  const sessionId = crypto.randomUUID();
  await insertActiveSession({
    agentId,
    taskId,
    triggerType: "task_assigned",
    runnerSessionId: sessionId,
  });
  expect((await post(body({ sessionId, taskId: undefined }))).status).toBe(409);
  expect((await post(body({ sessionId, taskId: crypto.randomUUID() }))).status).toBe(409);
  expect((await post(body({ sessionId }))).status).toBe(201);
});

test("legacy plan reports clear stale raw detection without changing manual choices", async () => {
  const suffix = "legacyplus";
  await recordKeyUsage("CODEX_OAUTH", suffix, 1, null, "global", null, null, "pro");
  await setApiKeyPlan("CODEX_OAUTH", suffix, "chatgpt_pro_500");
  await recordKeyUsage("CODEX_OAUTH", suffix, 1, null, "global", null, "chatgpt_plus");
  expect(
    await getDbClient().get(
      "SELECT plan, planSource, detectedPlanRaw FROM api_key_status WHERE keySuffix = ?",
      [suffix],
    ),
  ).toEqual({ plan: "chatgpt_pro_500", planSource: "manual", detectedPlanRaw: null });
});

test("historical credential coverage separates unknown spend from known billing types", async () => {
  const coverageAgentId = crypto.randomUUID();
  await createAgent({
    id: coverageAgentId,
    name: "Coverage worker",
    isLead: false,
    status: "idle",
  });
  for (const [credentialKeyType, totalCostUsd] of [
    [null, 7],
    ["CODEX_OAUTH", 3],
    ["OPENAI_API_KEY", 2],
  ] as const) {
    await createSessionCost({
      sessionId: crypto.randomUUID(),
      agentId: coverageAgentId,
      credentialKeyType,
      credentialKeySuffix: credentialKeyType ? "coverage" : null,
      totalCostUsd,
      durationMs: 1,
      numTurns: 1,
      model: "gpt-5",
    });
  }
  const summary = await getSessionCostSummary({ agentId: coverageAgentId, groupBy: "both" });
  expect(summary.totals).toMatchObject({
    totalCostUsd: 12,
    subscriptionCostUsd: 3,
    credentialUnattributedCostUsd: 7,
    credentialUnattributedSessions: 1,
  });
  expect(summary.daily).toHaveLength(1);
  expect(summary.daily[0]).toMatchObject({
    costUsd: 12,
    subscriptionCostUsd: 3,
    credentialUnattributedCostUsd: 7,
    credentialUnattributedSessions: 1,
  });
  expect(summary.byCredential.find((row) => row.keyType === null)?.costUsd).toBe(7);
});

test("sessions recorded before migration 307 read their task's credential", async () => {
  const legacyAgentId = crypto.randomUUID();
  await createAgent({ id: legacyAgentId, name: "Legacy worker", isLead: false, status: "idle" });
  const task = await createTaskExtended("Legacy attribution", {
    agentId: legacyAgentId,
    source: "system",
  });
  // The task's credential moved on to another key after the legacy run.
  await getDbClient().run(
    "UPDATE agent_tasks SET credentialKeyType = 'CLAUDE_CODE_OAUTH_TOKEN', credentialKeySuffix = 'legcy' WHERE id = ?",
    [task.id],
  );
  const session = async (
    totalCostUsd: number,
    credential: { credentialKeyType: string; credentialKeySuffix: string } | null,
  ) => {
    const cost = await createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId: task.id,
      agentId: legacyAgentId,
      ...credential,
      totalCostUsd,
      durationMs: 1,
      numTurns: 1,
      model: "claude-sonnet",
    });
    return cost.id;
  };
  const legacy = await session(5, null);
  await getDbClient().run("UPDATE session_costs SET createdAt = ? WHERE id = ?", [
    "2020-01-01T00:00:00.000Z",
    legacy,
  ]);
  await session(3, { credentialKeyType: "OPENAI_API_KEY", credentialKeySuffix: "own01" });
  await session(2, null);

  const summary = await getSessionCostSummary({ agentId: legacyAgentId, groupBy: "both" });
  expect(summary.totals).toMatchObject({
    totalCostUsd: 10,
    subscriptionCostUsd: 5,
    credentialUnattributedCostUsd: 2,
    credentialUnattributedSessions: 1,
  });
  expect(
    summary.byCredential.map(({ keyType, keySuffix, costUsd }) => [keyType, keySuffix, costUsd]),
  ).toEqual([
    ["CLAUDE_CODE_OAUTH_TOKEN", "legcy", 5],
    ["OPENAI_API_KEY", "own01", 3],
    [null, null, 2],
  ]);
  expect(
    (await getKeyCostSummary("CLAUDE_CODE_OAUTH_TOKEN")).find((row) => row.keySuffix === "legcy"),
  ).toMatchObject({ totalCost: 5, taskCount: 1 });
});
