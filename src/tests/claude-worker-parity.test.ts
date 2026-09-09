import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApiClient,
  asRecord,
  createApiClient,
  expectStatus,
  pollUntil,
} from "../../scripts/e2e/http";
import { minimalEnv, repoRoot, type Sut, startSut, stopSut } from "../../scripts/e2e/sut";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLI_AGENT_ID = "1a111111-1111-4111-8111-111111111111";
const SDK_AGENT_ID = "1a222222-2222-4222-8222-222222222222";
const SESSION_ID = "1a333333-3333-4333-8333-333333333333";
const ROTATION_AGENT_ID = "1a444444-4444-4444-8444-444444444444";
const FIXTURE_SUMMARY =
  "The worker fixture completed a transport parity task with durable evidence.";
const FIXTURE_OAUTH = "synthetic-fixture-oauth-token";
const FIXTURE_API_KEY = "synthetic-fixture-anthropic-api-key";
const ROTATION_OAUTH_POOL = ["synthetic-rotation-oauth-oa001", "synthetic-rotation-oauth-oa002"];
const ROTATION_API_POOL = ["synthetic-rotation-api-ap001", "synthetic-rotation-api-ap002"];

let sut: Sut;
let api: ApiClient;
let fixtureDir: string;
let fixturePath: string;
let pm2StubPath: string;
let openRouterMock: Bun.Server;

const fixtureSource = `#!/usr/bin/env bun
const sessionId = ${JSON.stringify(SESSION_ID)};
const summary = ${JSON.stringify(FIXTURE_SUMMARY)};
const expectedOAuth = ${JSON.stringify(FIXTURE_OAUTH)};
const expectedApiKey = ${JSON.stringify(FIXTURE_API_KEY)};
const argv = process.argv.slice(2);
const rotationMode = process.env.CLAUDE_FIXTURE_ROTATION === "1";
const observationFile = process.env.CLAUDE_FIXTURE_OBSERVATION_FILE;

if (
  !argv.includes("--version") &&
  (!process.env.CLAUDE_CODE_OAUTH_TOKEN || !process.env.ANTHROPIC_API_KEY ||
    (!rotationMode &&
      (process.env.CLAUDE_CODE_OAUTH_TOKEN !== expectedOAuth ||
        process.env.ANTHROPIC_API_KEY !== expectedApiKey)))
) {
  process.exit(3);
}

async function recordObservation() {
  if (rotationMode && observationFile) {
    await Bun.write(
      observationFile,
      JSON.stringify({
        oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        api: process.env.ANTHROPIC_API_KEY,
      }),
    );
  }
}

function emit(value) {
  console.log(JSON.stringify(value));
}

function init() {
  emit({ type: "system", subtype: "init", session_id: sessionId, model: "claude-haiku-4-5", uuid: crypto.randomUUID() });
}

function assistant() {
  emit({
    type: "assistant",
    message: {
      id: "fixture-message",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: "Fixture completed the requested transport parity task." }],
      usage: { input_tokens: 24, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  });
}

function compact() {
  emit({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 24 },
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  });
}

function result() {
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Fixture completed the requested transport parity task.",
    total_cost_usd: 0.004,
    duration_ms: 12,
    num_turns: 1,
    usage: { input_tokens: 24, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-haiku-4-5": { inputTokens: 24, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000, costUSD: 0.004 } },
    queued_turn_count: 0,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  });
}

async function runSession() {
  init();
  assistant();
  compact();
  result();
}

if (argv.includes("--version")) {
  console.log("2.1.263 (Claude Code)");
  process.exit(0);
}

if (argv.includes("--output-format") && argv[argv.indexOf("--output-format") + 1] === "json") {
  console.log(JSON.stringify({ result: JSON.stringify({ summary, ratings: [] }), structured_output: { summary, ratings: [] } }));
  process.exit(0);
}

if (argv.includes("-p")) {
  await recordObservation();
  await runSession();
  process.exit(0);
}

await recordObservation();

let initialized = false;
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) {
      newline = buffer.indexOf("\\n");
      continue;
    }
    const message = JSON.parse(line);
    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      if (!initialized) {
        initialized = true;
        init();
      }
    } else if (message.type === "user") {
      if (!initialized) {
        console.error("fixture received user input before initialize");
        process.exit(4);
      }
      assistant();
      compact();
      result();
      process.exit(0);
    }
    newline = buffer.indexOf("\\n");
  }
}
`;

async function waitForJson(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  let latest: Record<string, unknown> = {};
  const found = await pollUntil(
    async () => {
      const response = await api("GET", path);
      if (response.status !== 200 || typeof response.json !== "object" || response.json === null) {
        return false;
      }
      latest = asRecord(response.json);
      return predicate(latest);
    },
    timeoutMs,
    250,
  );
  if (!found) {
    throw new Error(`Timed out waiting for ${path}: ${scrubSecrets(JSON.stringify(latest))}`);
  }
  return latest;
}

async function waitForFixtureObservation(path: string): Promise<{ oauth: string; api: string }> {
  let latest = "";
  const found = await pollUntil(
    async () => {
      if (!(await Bun.file(path).exists())) return false;
      latest = await Bun.file(path).text();
      try {
        const value = JSON.parse(latest) as Record<string, unknown>;
        return typeof value.oauth === "string" && typeof value.api === "string";
      } catch {
        return false;
      }
    },
    45_000,
    100,
  );
  if (!found) {
    throw new Error(`Timed out waiting for fixture observation: ${scrubSecrets(latest)}`);
  }
  const value = JSON.parse(latest) as Record<string, unknown>;
  return { oauth: String(value.oauth), api: String(value.api) };
}

async function runTransport(transport: "cli" | "sdk", agentId: string): Promise<void> {
  const registration = await api("POST", "/api/agents", {
    agentId,
    body: { name: `claude-worker-${transport}`, role: "worker", status: "online" },
  });
  expectStatus(registration, [201], `${transport} agent registration`);

  const config = await api("PUT", "/api/config", {
    body: { scope: "agent", scopeId: agentId, key: "CLAUDE_TRANSPORT", value: transport },
  });
  expectStatus(config, [200], `${transport} transport config`);

  const created = await api("POST", "/api/tasks", {
    body: {
      task: `Run the deterministic Claude ${transport} transport parity fixture and report completion.`,
      agentId,
      source: "api",
    },
  });
  expectStatus(created, [201], `${transport} task creation`);
  const task = asRecord(created.json);
  const taskId = String(task.id);
  expect(UUID_RE.test(taskId)).toBeTrue();

  const home = await mkdtemp(join(fixtureDir, `home-${transport}-`));
  const workerEnv = {
    ...minimalEnv(),
    PATH: `${pm2StubPath}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    AGENT_SWARM_API_KEY: sut.apiKey,
    API_KEY: sut.apiKey,
    MCP_BASE_URL: sut.baseUrl,
    AGENT_ID: agentId,
    AGENT_NAME: `claude-worker-${transport}`,
    HARNESS_PROVIDER: "claude",
    CLAUDE_TRANSPORT: transport,
    CLAUDE_BINARY: fixturePath,
    CLAUDE_CODE_OAUTH_TOKEN: FIXTURE_OAUTH,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENROUTER_API_KEY: "synthetic-fixture-openrouter-key",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${openRouterMock.port}`,
    CRED_CHECK_DISABLE: "1",
    CLAUDE_QUEUE_STEERING: "0",
    ANONYMIZED_TELEMETRY: "false",
    SLACK_DISABLE: "true",
    GITHUB_DISABLE: "true",
    LINEAR_DISABLE: "true",
    JIRA_DISABLE: "true",
    AGENTMAIL_DISABLE: "true",
  };
  const worker = Bun.spawn([process.execPath, "run", "src/cli.tsx", "worker", "--yolo"], {
    cwd: repoRoot,
    env: workerEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(worker.stdout).text();
  const stderrPromise = new Response(worker.stderr).text();
  try {
    const finished = await waitForJson(
      `/api/tasks/${taskId}`,
      (value) => value.status === "completed",
    );
    expect(asRecord(finished.providerMeta).transport).toBe(transport);
    expect(finished.credentialKeyType).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(finished.credentialKeySuffix).toBe(FIXTURE_OAUTH.slice(-5));

    const cost = await waitForJson(
      `/api/session-costs?taskId=${taskId}`,
      (value) => Array.isArray(value.costs) && value.costs.length > 0,
    );
    const costs = (cost.costs as unknown[]).map(asRecord);
    expect(costs.some((row) => Number(row.totalCostUsd) > 0)).toBeTrue();
    expect(
      costs.some((row) => Number(row.inputTokens) > 0 && Number(row.outputTokens) > 0),
    ).toBeTrue();

    const context = await waitForJson(`/api/tasks/${taskId}/context`, (value) => {
      const summary = asRecord(value.summary);
      return Number(summary.snapshotCount) >= 2 && Number(summary.compactionCount) >= 1;
    });
    const contextSummary = asRecord(context.summary);
    expect(Number(contextSummary.snapshotCount)).toBeGreaterThanOrEqual(2);
    expect(Number(contextSummary.compactionCount)).toBeGreaterThanOrEqual(1);

    const memories = await api("POST", "/api/memory/list", {
      body: { agentId, source: "session_summary", scope: "agent", limit: 20 },
    });
    expectStatus(memories, [200], `${transport} session summary list`);
    const memoryRows = (asRecord(memories.json).results as unknown[]).map(asRecord);
    expect(memoryRows.some((row) => String(row.content).includes(FIXTURE_SUMMARY))).toBeTrue();

    const keyStatus = await waitForJson("/api/keys/status", (value) => {
      const keys = Array.isArray(value.keys) ? value.keys.map(asRecord) : [];
      const oauth = keys.find(
        (row) => row.keyType === "CLAUDE_CODE_OAUTH_TOKEN" && row.keySuffix === "token",
      );
      const apiKey = keys.find(
        (row) => row.keyType === "ANTHROPIC_API_KEY" && row.keySuffix === "i-key",
      );
      return Number(oauth?.totalUsageCount) > 0 && Number(apiKey?.totalUsageCount) > 0;
    });
    const keyRows = (keyStatus.keys as unknown[]).map(asRecord);
    const oauthRow = keyRows.find(
      (row) => row.keyType === "CLAUDE_CODE_OAUTH_TOKEN" && row.keySuffix === "token",
    );
    const apiKeyRow = keyRows.find(
      (row) => row.keyType === "ANTHROPIC_API_KEY" && row.keySuffix === "i-key",
    );
    expect(Number(oauthRow?.totalUsageCount)).toBeGreaterThan(0);
    expect(Number(apiKeyRow?.totalUsageCount)).toBeGreaterThan(0);
    expect(oauthRow?.provider).toBe("claude");
    expect(apiKeyRow?.provider).toBe("claude");
  } catch (error) {
    worker.kill("SIGKILL");
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    throw new Error(
      scrubSecrets(
        `${String(error)}\nworker stdout:\n${stdout.slice(-4000)}\nworker stderr:\n${stderr.slice(-4000)}`,
      ),
    );
  } finally {
    if (worker.exitCode === null) {
      worker.kill("SIGTERM");
      await Promise.race([worker.exited, Bun.sleep(5_000)]);
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
    await worker.exited.catch(() => {});
    await Promise.all([stdoutPromise, stderrPromise]);
    await rm(home, { recursive: true, force: true });
  }
}

async function runCredentialRotation(): Promise<void> {
  const registration = await api("POST", "/api/agents", {
    agentId: ROTATION_AGENT_ID,
    body: { name: "claude-worker-rotation", role: "worker", status: "online" },
  });
  expectStatus(registration, [201], "rotation agent registration");

  const config = await api("PUT", "/api/config", {
    body: {
      scope: "agent",
      scopeId: ROTATION_AGENT_ID,
      key: "CLAUDE_TRANSPORT",
      value: "sdk",
    },
  });
  expectStatus(config, [200], "rotation transport config");

  const firstCreated = await api("POST", "/api/tasks", {
    body: {
      task: "Run the first deterministic credential rotation fixture task.",
      agentId: ROTATION_AGENT_ID,
      source: "api",
    },
  });
  expectStatus(firstCreated, [201], "first rotation task creation");
  const firstTaskId = String(asRecord(firstCreated.json).id);
  expect(UUID_RE.test(firstTaskId)).toBeTrue();

  const home = await mkdtemp(join(fixtureDir, "home-rotation-"));
  const observationFile = join(home, "fixture-observation.json");
  const workerEnv = {
    ...minimalEnv(),
    PATH: `${pm2StubPath}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    AGENT_SWARM_API_KEY: sut.apiKey,
    API_KEY: sut.apiKey,
    MCP_BASE_URL: sut.baseUrl,
    AGENT_ID: ROTATION_AGENT_ID,
    AGENT_NAME: "claude-worker-rotation",
    HARNESS_PROVIDER: "claude",
    CLAUDE_TRANSPORT: "sdk",
    CLAUDE_BINARY: fixturePath,
    CLAUDE_FIXTURE_ROTATION: "1",
    CLAUDE_FIXTURE_OBSERVATION_FILE: observationFile,
    CLAUDE_CODE_OAUTH_TOKEN: ROTATION_OAUTH_POOL.join(","),
    ANTHROPIC_API_KEY: ROTATION_API_POOL.join(","),
    OPENROUTER_API_KEY: "synthetic-fixture-openrouter-key",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${openRouterMock.port}`,
    CRED_CHECK_DISABLE: "1",
    CLAUDE_QUEUE_STEERING: "0",
    ANONYMIZED_TELEMETRY: "false",
    SLACK_DISABLE: "true",
    GITHUB_DISABLE: "true",
    LINEAR_DISABLE: "true",
    JIRA_DISABLE: "true",
    AGENTMAIL_DISABLE: "true",
  };
  const worker = Bun.spawn([process.execPath, "run", "src/cli.tsx", "worker", "--yolo"], {
    cwd: repoRoot,
    env: workerEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(worker.stdout).text();
  const stderrPromise = new Response(worker.stderr).text();

  try {
    const first = await waitForJson(
      `/api/tasks/${firstTaskId}`,
      (value) =>
        value.status === "completed" &&
        typeof value.credentialKeyType === "string" &&
        typeof value.credentialKeySuffix === "string",
    );
    const firstObservation = await waitForFixtureObservation(observationFile);
    expect(ROTATION_OAUTH_POOL).toContain(firstObservation.oauth);
    expect(ROTATION_API_POOL).toContain(firstObservation.api);
    expect(first.credentialKeyType).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(first.credentialKeySuffix).toBe(firstObservation.oauth.slice(-5));

    await waitForJson("/api/keys/status", (value) => {
      const keys = Array.isArray(value.keys) ? value.keys.map(asRecord) : [];
      const selected = [
        ["CLAUDE_CODE_OAUTH_TOKEN", firstObservation.oauth],
        ["ANTHROPIC_API_KEY", firstObservation.api],
      ] as const;
      return selected.every(([keyType, key]) =>
        keys.some(
          (row) =>
            row.keyType === keyType &&
            row.keySuffix === key.slice(-5) &&
            Number(row.totalUsageCount) > 0 &&
            row.status !== "rate_limited",
        ),
      );
    });

    const cooldownUntil = new Date(Date.now() + 120_000).toISOString();
    for (const [keyType, key, keyIndex] of [
      [
        "CLAUDE_CODE_OAUTH_TOKEN",
        firstObservation.oauth,
        ROTATION_OAUTH_POOL.indexOf(firstObservation.oauth),
      ],
      ["ANTHROPIC_API_KEY", firstObservation.api, ROTATION_API_POOL.indexOf(firstObservation.api)],
    ] as const) {
      const response = await api("POST", "/api/keys/report-rate-limit", {
        body: { keyType, keySuffix: key.slice(-5), keyIndex, rateLimitedUntil: cooldownUntil },
      });
      expectStatus(response, [200], `${keyType} rotation cooldown`);
    }

    await waitForJson("/api/keys/status", (value) => {
      const keys = Array.isArray(value.keys) ? value.keys.map(asRecord) : [];
      return [
        ["CLAUDE_CODE_OAUTH_TOKEN", firstObservation.oauth],
        ["ANTHROPIC_API_KEY", firstObservation.api],
      ].every(([keyType, key]) =>
        keys.some(
          (row) =>
            row.keyType === keyType &&
            row.keySuffix === key.slice(-5) &&
            row.status === "rate_limited",
        ),
      );
    });

    const secondCreated = await api("POST", "/api/tasks", {
      body: {
        task: "Run the second deterministic credential rotation fixture task.",
        agentId: ROTATION_AGENT_ID,
        source: "api",
      },
    });
    expectStatus(secondCreated, [201], "second rotation task creation");
    const secondTaskId = String(asRecord(secondCreated.json).id);
    expect(UUID_RE.test(secondTaskId)).toBeTrue();

    const second = await waitForJson(
      `/api/tasks/${secondTaskId}`,
      (value) =>
        value.status === "completed" &&
        value.credentialKeyType === "CLAUDE_CODE_OAUTH_TOKEN" &&
        typeof value.credentialKeySuffix === "string",
    );
    const secondObservation = await waitForFixtureObservation(observationFile);
    expect(secondObservation.oauth).toBe(
      ROTATION_OAUTH_POOL.find((value) => value !== firstObservation.oauth),
    );
    expect(secondObservation.api).toBe(
      ROTATION_API_POOL.find((value) => value !== firstObservation.api),
    );
    expect(second.credentialKeySuffix).toBe(secondObservation.oauth.slice(-5));
    expect(second.credentialKeyType).toBe("CLAUDE_CODE_OAUTH_TOKEN");
  } catch (error) {
    worker.kill("SIGKILL");
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    throw new Error(
      scrubSecrets(
        `${String(error)}\nworker stdout:\n${stdout.slice(-4000)}\nworker stderr:\n${stderr.slice(-4000)}`,
      ),
    );
  } finally {
    if (worker.exitCode === null) {
      worker.kill("SIGTERM");
      await Promise.race([worker.exited, Bun.sleep(5_000)]);
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
    await worker.exited.catch(() => {});
    await Promise.all([stdoutPromise, stderrPromise]);
    await rm(home, { recursive: true, force: true });
  }
}

describe("Claude worker transport parity", () => {
  beforeAll(async () => {
    for (const value of [...ROTATION_OAUTH_POOL, ...ROTATION_API_POOL]) {
      registerVolatileSecret(value, "CLAUDE_FIXTURE_POOL");
    }
    fixtureDir = await mkdtemp("/tmp/claude-worker-parity-");
    fixturePath = join(fixtureDir, "claude-fixture");
    pm2StubPath = join(fixtureDir, "bin");
    await Bun.$`mkdir -p ${pm2StubPath}`.quiet();
    await Bun.write(fixturePath, fixtureSource);
    await Bun.write(join(pm2StubPath, "pm2"), "#!/bin/sh\nexit 0\n");
    await Bun.$`chmod 755 ${fixturePath}`.quiet();
    await Bun.$`chmod 755 ${join(pm2StubPath, "pm2")}`.quiet();
    openRouterMock = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "tool_fixture", type: "function", function: { name: "record_session_summary", arguments: JSON.stringify({ summary: FIXTURE_SUMMARY, ratings: [] }) } }] }, finish_reason: null }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    sut = await startSut(false, {}, { SLACK_DISABLE: "true" });
    api = createApiClient(sut.baseUrl, sut.apiKey);
  }, 75_000);

  afterAll(async () => {
    openRouterMock?.stop();
    if (sut) await stopSut(sut, false);
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  test("persists CLI and SDK transport metadata, costs, context, compaction, and summaries", async () => {
    await runTransport("cli", CLI_AGENT_ID);
    await runTransport("sdk", SDK_AGENT_ID);
  }, 150_000);

  test("rotates pooled Claude credentials on the same SDK worker", async () => {
    await runCredentialRotation();
  }, 120_000);
});
