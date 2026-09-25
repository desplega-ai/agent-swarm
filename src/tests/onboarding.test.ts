import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createUser,
  getDbClient,
  getSwarmConfigs,
  initDb,
  setAgentHarnessProvider,
  updateAgentCredStatus,
  upsertSwarmConfig,
} from "../be/db";
import { resetEmbeddingProvider } from "../be/memory";
import {
  type OnboardingState,
  OnboardingStateSchema,
  updateOnboardingAiFromCodexDevice,
} from "../be/onboarding";
import { _resetAutoReloadForTests, handleCore } from "../http/core";
import { handleOnboarding } from "../http/onboarding";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { telemetry } from "../telemetry";
import { listenOnFreePort } from "./test-net";

const API_KEY = "example-onboarding-test-key";
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "EMBEDDING_API_KEY",
  "EMBEDDING_API_BASE_URL",
  "EMBEDDING_MODEL",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_MODE",
];

let server: Server;
let baseUrl: string;
const savedEnv = new Map<string, string | undefined>();
const capturedTelemetry: Array<{
  event: string;
  properties: Record<string, string | boolean | number>;
}> = [];
const originalOnboardingTelemetry = telemetry.onboarding;

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  telemetry.onboarding = (event, properties) => capturedTelemetry.push({ event, properties });
  initDb(":memory:");
  server = createServer(async (req, res) => {
    if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, API_KEY)) {
      return;
    }
    const segments = getPathSegments(req.url || "");
    const query = parseQueryParams(req.url || "");
    if (await handleOnboarding(req, res, segments, query)) return;
    res.writeHead(404).end();
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  _resetAutoReloadForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  telemetry.onboarding = originalOnboardingTelemetry;
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  await Bun.sleep(0);
  const client = getDbClient();
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM agents");
  await client.run("DELETE FROM users");
  await client.run("DELETE FROM oauth_authorizations");
  await client.run("DELETE FROM oauth_apps");
  await client.run("DELETE FROM swarm_config");
  for (const key of ENV_KEYS) delete process.env[key];
  capturedTelemetry.length = 0;
  resetEmbeddingProvider();
  _resetAutoReloadForTests();
});

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
}

async function request(
  path: string,
  init?: { method?: string; body?: Record<string, unknown> },
): Promise<Response> {
  return await fetch(`${baseUrl}${path}`, {
    method: init?.method,
    headers: headers(),
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function put(action: Record<string, unknown>): Promise<Response> {
  return await request("/api/onboarding", { method: "PUT", body: action });
}

async function getState(): Promise<OnboardingState> {
  const rows = await getSwarmConfigs({ scope: "global", key: "onboarding_state" });
  return JSON.parse(rows[0]!.value) as OnboardingState;
}

async function insertTask(options: {
  id: string;
  status?: string;
  taskType?: string | null;
  requestedByUserId?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO agent_tasks (
       id, task, status, source, taskType, requestedByUserId, swarmVersion, createdAt, lastUpdatedAt
     ) VALUES (?, ?, ?, 'ui', ?, ?, '1.0.0', ?, ?)`,
    [
      options.id,
      `Task ${options.id}`,
      options.status ?? "in_progress",
      options.taskType ?? null,
      options.requestedByUserId ?? null,
      now,
      now,
    ],
  );
}

async function expectExistingInstall(): Promise<void> {
  const response = await request("/api/onboarding");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { state: OnboardingState };
  expect(body.state.autoCompleted).toBe(true);
  expect(body.state.completedAt).not.toBeNull();
  // Existing installs still derive live steps, so "Run setup again" is truthful...
  expect(body.state.steps.connect.status).toBe("done");
  // ...but they never feed the funnel beyond the one `started` event.
  expect(capturedTelemetry.map((entry) => entry.event)).toEqual(["started"]);
}

function startEmbeddingServer(response: () => Response): {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
} {
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return response();
    },
  });
  return { server: fake, baseUrl: `http://127.0.0.1:${fake.port}/v1` };
}

function embeddingResponse(dimensions: number): Response {
  return Response.json({
    object: "list",
    data: [{ object: "embedding", index: 0, embedding: Array(dimensions).fill(0.1) }],
    model: "test-embedding-model",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
}

describe("onboarding state", () => {
  test("fresh install creates active onboarding state", async () => {
    const response = await request("/api/onboarding");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { state: OnboardingState };

    expect(body.state.autoCompleted).toBe(false);
    expect(body.state.completedAt).toBeNull();
    expect(body.state.version).toBe(1);
  });

  test("concurrent first GETs create state and started telemetry once", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request("/api/onboarding")),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Bun.sleep(10);
    expect(capturedTelemetry.filter((entry) => entry.event === "started")).toHaveLength(1);
  });

  test("stored unknown methods parse as null for their step", async () => {
    const state = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
    };
    const stored = structuredClone(state.state) as unknown as {
      steps: Record<string, { method: unknown }>;
    };
    for (const step of Object.values(stored.steps)) step.method = "retired_method";

    const parsed = OnboardingStateSchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.values(parsed.data.steps).map((step) => step.method)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("a row stored before the agents step keeps its progress", async () => {
    const state = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
    };
    const stored = structuredClone(state.state) as unknown as {
      startedAt: string;
      steps: Record<string, unknown>;
    };
    stored.steps.name = {
      status: "done",
      at: stored.startedAt,
      method: "custom_name",
      errorClass: null,
    };
    delete stored.steps.agents;
    await upsertSwarmConfig({
      scope: "global",
      key: "onboarding_state",
      value: JSON.stringify(stored),
    });
    capturedTelemetry.length = 0;

    const body = (await (await request("/api/onboarding")).json()) as { state: OnboardingState };
    expect(body.state.startedAt).toBe(stored.startedAt);
    expect(body.state.steps.name).toMatchObject({ status: "done", method: "custom_name" });
    expect(body.state.steps.agents).toEqual({
      status: "todo",
      at: null,
      method: null,
      errorClass: null,
    });
    await Bun.sleep(10);
    expect(capturedTelemetry.filter((entry) => entry.event === "started")).toHaveLength(0);
  });

  test("a user row marks the install as existing", async () => {
    await createUser({ name: "Existing operator" });
    await expectExistingInstall();
  });

  test("a task with requestedByUserId marks the install as existing", async () => {
    const user = await createUser({ name: "Task requester" });
    await insertTask({ id: "requested-task", requestedByUserId: user.id });
    await expectExistingInstall();
  });

  test("a completed non-heartbeat task marks the install as existing", async () => {
    await insertTask({ id: "completed-real-task", status: "completed", taskType: "delegated" });
    await expectExistingInstall();
  });

  test("a failed or pending operator task marks the install as existing", async () => {
    await insertTask({ id: "failed-real-task", status: "failed", taskType: null });
    await expectExistingInstall();
  });

  test("system tasks alone do not mark the install as existing", async () => {
    await insertTask({ id: "triage-running", status: "in_progress", taskType: "boot-triage" });
    await insertTask({
      id: "checklist-pending",
      status: "pending",
      taskType: "heartbeat-checklist",
    });
    const body = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
    };

    expect(body.state.autoCompleted).toBe(false);
  });

  test("a completed boot-triage task alone does not mark the install as existing", async () => {
    await insertTask({ id: "boot-only", status: "completed", taskType: "boot-triage" });
    const body = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
    };

    expect(body.state.autoCompleted).toBe(false);
    expect(body.state.steps.connect.status).toBe("done");
  });

  test("GET derives the authenticated connection", async () => {
    const body = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
      signals: { providers: unknown[]; embeddings: { configured: boolean; dimensions: number } };
    };

    expect(body.state.steps.connect).toMatchObject({ status: "done", method: "api_key" });
    expect(body.signals.providers).toEqual([]);
    expect(body.signals.embeddings).toEqual({ configured: false, dimensions: 512 });
    expect((await getState()).steps.connect.status).toBe("done");
  });

  test("agent signals count idle or busy agents as ready", async () => {
    await createAgent({ name: "ready-lead", isLead: true, status: "idle" });
    await createAgent({ name: "busy-worker", isLead: false, status: "busy" });
    await createAgent({ name: "gone-worker", isLead: false, status: "offline" });
    const body = (await (await request("/api/onboarding")).json()) as {
      signals: { agents: { leadsOnline: number; workersOnline: number } };
    };
    expect(body.signals.agents).toEqual({ leadsOnline: 1, workersOnline: 1 });
  });

  test("GET derives verified AI from agent reports, leads included", async () => {
    const lead = await createAgent({ name: "claude-lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "claude-worker", isLead: false, status: "idle" });
    for (const agent of [lead, worker]) {
      await setAgentHarnessProvider(agent.id, "claude");
      await updateAgentCredStatus(agent.id, {
        ready: true,
        missing: [],
        satisfiedBy: "env",
        hint: null,
        liveTest: { ok: true, error: null, latency_ms: 7, testedAt: Date.now() },
        reportedAt: Date.now(),
        reportKind: "boot",
      });
    }
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "example-claude-setup-token";

    const body = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
      signals: { providers: Array<Record<string, unknown>> };
    };
    expect(body.signals.providers).toEqual([
      { provider: "claude", state: "verified", workers: 2, verifiedWorkers: 2 },
    ]);
    expect(body.state.steps.ai).toMatchObject({
      status: "done",
      method: "claude_setup_token",
    });
  });

  test("GET derives integrations from environment configuration", async () => {
    process.env.GITHUB_TOKEN = "example-github-token";
    const body = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
      signals: { integrations: Record<string, boolean> };
    };

    expect(body.signals.integrations.github).toBe(true);
    expect(body.state.steps.integrations).toMatchObject({ status: "done", method: "github" });
  });

  test("the selected first task completes onboarding after that task completes", async () => {
    // Onboarding starts before the first task exists (the task alone would mark an existing install).
    await request("/api/onboarding");
    await insertTask({ id: "first-task" });
    const selected = await put({
      action: "first_task",
      taskId: "first-task",
      method: "suggestion",
    });
    expect(selected.status).toBe(200);
    expect(((await selected.json()) as { state: OnboardingState }).state.completedAt).toBeNull();

    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [
      "first-task",
    ]);
    const completed = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
    };
    expect(completed.state.steps.first_task).toMatchObject({
      status: "done",
      method: "suggestion",
    });
    expect(completed.state.completedAt).not.toBeNull();
  });

  test("first_task PUT derives an already completed task before responding", async () => {
    await request("/api/onboarding");
    await insertTask({ id: "already-completed", status: "completed" });

    const response = await put({
      action: "first_task",
      taskId: "already-completed",
      method: "free_form",
    });
    const body = (await response.json()) as { state: OnboardingState };
    expect(body.state.steps.first_task).toMatchObject({
      status: "done",
      method: "free_form",
    });
    expect(body.state.completedAt).not.toBeNull();
  });

  test("PUT applies all onboarding transitions without duplicate completion telemetry", async () => {
    await request("/api/onboarding");
    capturedTelemetry.length = 0;

    let response = await put({ action: "complete", step: "connect", method: "api_key" });
    expect(response.status).toBe(200);

    response = await put({ action: "view", step: "name" });
    expect(((await response.json()) as { state: OnboardingState }).state.currentStep).toBe("name");

    response = await put({ action: "complete", step: "name", method: "custom_name" });
    expect(((await response.json()) as { state: OnboardingState }).state.steps.name).toMatchObject({
      status: "done",
      method: "custom_name",
    });
    await Bun.sleep(10);
    const completionEvents = capturedTelemetry.filter(
      (item) => item.event === "step_completed" && item.properties.step === "name",
    ).length;

    response = await put({ action: "complete", step: "name", method: "default_name" });
    expect(((await response.json()) as { state: OnboardingState }).state.steps.name.method).toBe(
      "default_name",
    );
    await Bun.sleep(10);
    expect(
      capturedTelemetry.filter(
        (item) => item.event === "step_completed" && item.properties.step === "name",
      ),
    ).toHaveLength(completionEvents);

    response = await put({ action: "complete", step: "ai", method: "openrouter" });
    expect(((await response.json()) as { state: OnboardingState }).state.steps.ai.status).toBe(
      "done",
    );
    response = await put({ action: "complete", step: "agents", method: "optimal" });
    expect(
      ((await response.json()) as { state: OnboardingState }).state.steps.agents,
    ).toMatchObject({ status: "done", method: "optimal" });
    response = await put({ action: "complete", step: "integrations", method: "github" });
    expect(
      ((await response.json()) as { state: OnboardingState }).state.steps.integrations.status,
    ).toBe("done");
    response = await put({ action: "skip", step: "memory" });
    expect(((await response.json()) as { state: OnboardingState }).state.steps.memory.status).toBe(
      "skipped",
    );
    response = await put({ action: "fail", step: "first_task", errorClass: "network" });
    expect(
      ((await response.json()) as { state: OnboardingState }).state.steps.first_task,
    ).toMatchObject({ status: "failed", errorClass: "network" });

    await insertTask({ id: "put-first-task" });
    response = await put({
      action: "first_task",
      taskId: "put-first-task",
      method: "free_form",
    });
    expect(((await response.json()) as { state: OnboardingState }).state).toMatchObject({
      firstTaskId: "put-first-task",
      steps: { first_task: { method: "free_form" } },
    });

    response = await put({ action: "minimize" });
    expect(
      ((await response.json()) as { state: OnboardingState }).state.minimizedAt,
    ).not.toBeNull();
    response = await put({ action: "resume" });
    expect(((await response.json()) as { state: OnboardingState }).state).toMatchObject({
      minimizedAt: null,
      dismissedAt: null,
    });
    response = await put({ action: "dismiss" });
    expect(
      ((await response.json()) as { state: OnboardingState }).state.dismissedAt,
    ).not.toBeNull();

    expect(
      (
        await put({
          action: "first_task",
          taskId: "missing-task",
          method: "free_form",
        })
      ).status,
    ).toBe(404);
  });

  test("PUT rejects a bad completion method and connect skip", async () => {
    expect((await put({ action: "complete", step: "ai", method: "not-a-provider" })).status).toBe(
      400,
    );
    expect((await put({ action: "complete", step: "agents", method: "turbo" })).status).toBe(400);
    expect((await put({ action: "skip", step: "connect" })).status).toBe(400);
    expect((await put({ action: "skip", step: "agents" })).status).toBe(200);
  });

  test("skip, dismiss, and fail transitions emit telemetry once", async () => {
    await request("/api/onboarding");
    capturedTelemetry.length = 0;

    await put({ action: "skip", step: "name" });
    await put({ action: "skip", step: "name" });
    await put({ action: "dismiss" });
    await put({ action: "dismiss" });
    await put({ action: "fail", step: "memory", errorClass: "network" });
    await put({ action: "fail", step: "memory", errorClass: "auth" });
    await Bun.sleep(10);

    expect(capturedTelemetry.filter((entry) => entry.event === "step_skipped")).toHaveLength(1);
    expect(capturedTelemetry.filter((entry) => entry.event === "dismissed")).toHaveLength(1);
    expect(capturedTelemetry.filter((entry) => entry.event === "step_failed")).toHaveLength(1);
    expect((await getState()).steps.memory.errorClass).toBe("network");
  });

  test("a failed action does not overwrite a completed step", async () => {
    await request("/api/onboarding");
    await put({ action: "complete", step: "name", method: "custom_name" });
    capturedTelemetry.length = 0;

    const response = await put({ action: "fail", step: "name", errorClass: "unknown" });
    expect(((await response.json()) as { state: OnboardingState }).state.steps.name).toMatchObject({
      status: "done",
      method: "custom_name",
      errorClass: null,
    });
    await Bun.sleep(10);
    expect(capturedTelemetry).toEqual([]);
  });

  test("auto-completed installs emit no telemetry after started", async () => {
    await createUser({ name: "Existing operator" });
    await request("/api/onboarding");
    capturedTelemetry.length = 0;

    await put({ action: "view", step: "name" });
    await request("/api/onboarding/memory", {
      method: "POST",
      body: { preset: "custom", baseUrl: "https://embeddings.example.com/v1" },
    });
    await updateOnboardingAiFromCodexDevice({ status: "failed", errorClass: "unknown" });
    await Bun.sleep(10);

    expect(capturedTelemetry).toEqual([]);
  });
});

describe("onboarding memory probe", () => {
  test("saves a successful probe through a local embeddings server", async () => {
    const fake = startEmbeddingServer(() => embeddingResponse(512));
    try {
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "custom",
          baseUrl: fake.baseUrl,
          model: "test-embedding-model",
          apiKey: "example-openai-key",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, dimensions: 512 });
    } finally {
      fake.server.stop(true);
    }

    const configs = await getSwarmConfigs({ scope: "global" });
    expect(Object.fromEntries(configs.map((config) => [config.key, config.value]))).toMatchObject({
      EMBEDDING_API_BASE_URL: fake.baseUrl,
      EMBEDDING_MODEL: "test-embedding-model",
      EMBEDDING_API_KEY: "example-openai-key",
    });
    expect((await getState()).steps.memory).toMatchObject({
      status: "done",
      method: "custom",
      errorClass: null,
    });
  });

  test("classifies a local 401 embeddings response as auth", async () => {
    const fake = startEmbeddingServer(() =>
      Response.json(
        { error: { message: "secret upstream diagnostic", type: "invalid_request_error" } },
        { status: 401 },
      ),
    );
    try {
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "custom",
          baseUrl: fake.baseUrl,
          model: "test-embedding-model",
          apiKey: "bad-key",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: false,
        errorClass: "auth",
        error: "The endpoint rejected the key (401).",
      });
    } finally {
      fake.server.stop(true);
    }

    expect((await getState()).steps.memory).toMatchObject({
      status: "failed",
      errorClass: "auth",
    });
  });

  test("a wrong dimension keeps memory done after a successful probe", async () => {
    let dimensions = 512;
    const fake = startEmbeddingServer(() => embeddingResponse(dimensions));
    try {
      const body = {
        preset: "custom",
        baseUrl: fake.baseUrl,
        model: "test-embedding-model",
        apiKey: "example-openai-key",
      };
      expect(
        await (await request("/api/onboarding/memory", { method: "POST", body })).json(),
      ).toMatchObject({ ok: true, dimensions: 512 });
      expect((await getState()).steps.memory.status).toBe("done");

      capturedTelemetry.length = 0;
      dimensions = 12;
      const response = await request("/api/onboarding/memory", { method: "POST", body });
      expect(await response.json()).toMatchObject({ ok: false, errorClass: "dimension" });
      await Bun.sleep(10);
    } finally {
      fake.server.stop(true);
    }

    expect((await getState()).steps.memory).toMatchObject({
      status: "done",
      method: "custom",
      errorClass: null,
    });
    expect(capturedTelemetry).toEqual([]);
  });

  test("rejects malformed URLs with 400 instead of throwing", async () => {
    const response = await request("/api/onboarding/memory", {
      method: "POST",
      body: {
        preset: "custom",
        baseUrl: "not a URL",
        model: "test-embedding-model",
        apiKey: "example-openai-key",
      },
    });
    expect(response.status).toBe(400);
  });

  test("input rejections leave the memory step unchanged", async () => {
    await request("/api/onboarding");
    const response = await request("/api/onboarding/memory", {
      method: "POST",
      body: { preset: "custom", baseUrl: "https://example.com/v1", model: "test-embedding-model" },
    });
    expect(((await response.json()) as { errorClass?: string }).errorClass).toBe("auth");
    expect((await getState()).steps.memory.status).toBe("todo");
  });

  test("does not send a reused OpenAI key to another host", async () => {
    let hits = 0;
    const fake = startEmbeddingServer(() => {
      hits += 1;
      return embeddingResponse(512);
    });
    process.env.OPENAI_API_KEY = "server-held-openai-key";
    try {
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "custom",
          baseUrl: fake.baseUrl,
          model: "test-embedding-model",
          reuseKey: "OPENAI_API_KEY",
        },
      });
      expect(await response.json()).toMatchObject({
        ok: false,
        errorClass: "auth",
        error: "Enter an API key for this endpoint.",
      });
      expect(hits).toBe(0);
    } finally {
      fake.server.stop(true);
    }
  });

  test("only existing preset uses the implicit embedding key", async () => {
    let hits = 0;
    const fake = startEmbeddingServer(() => {
      hits += 1;
      return embeddingResponse(512);
    });
    process.env.EMBEDDING_API_BASE_URL = fake.baseUrl;
    process.env.EMBEDDING_MODEL = "test-embedding-model";
    process.env.EMBEDDING_API_KEY = "existing-endpoint-key";
    try {
      const custom = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "custom",
          baseUrl: fake.baseUrl,
          model: "test-embedding-model",
        },
      });
      expect(await custom.json()).toMatchObject({ ok: false, errorClass: "auth" });
      expect(hits).toBe(0);

      const existing = await request("/api/onboarding/memory", {
        method: "POST",
        body: { preset: "existing" },
      });
      expect(await existing.json()).toMatchObject({ ok: true, dimensions: 512 });
      expect(hits).toBe(1);
    } finally {
      fake.server.stop(true);
    }
  });

  test("blocks private embedding endpoints outside local development", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "custom",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "test-embedding-model",
          apiKey: "example-openai-key",
        },
      });
      expect(await response.json()).toMatchObject({
        ok: false,
        errorClass: "network",
        error: "The endpoint URL is not allowed.",
      });
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("successful memory retry records the successful preset after a failure", async () => {
    let dimensions = 512;
    const fake = startEmbeddingServer(() => embeddingResponse(dimensions));
    try {
      const customBody = {
        preset: "custom",
        baseUrl: fake.baseUrl,
        model: "test-embedding-model",
        apiKey: "example-openai-key",
      };
      expect(
        await (
          await request("/api/onboarding/memory", { method: "POST", body: customBody })
        ).json(),
      ).toMatchObject({ ok: true });

      dimensions = 12;
      expect(
        await (
          await request("/api/onboarding/memory", { method: "POST", body: customBody })
        ).json(),
      ).toMatchObject({ ok: false, errorClass: "dimension" });

      process.env.EMBEDDING_API_BASE_URL = fake.baseUrl;
      process.env.EMBEDDING_MODEL = "test-embedding-model";
      process.env.EMBEDDING_API_KEY = "example-openai-key";
      dimensions = 512;
      expect(
        await (
          await request("/api/onboarding/memory", {
            method: "POST",
            body: { preset: "existing" },
          })
        ).json(),
      ).toMatchObject({ ok: true });
    } finally {
      fake.server.stop(true);
    }

    expect((await getState()).steps.memory).toMatchObject({
      status: "done",
      method: "existing",
      errorClass: null,
    });
  });
});
