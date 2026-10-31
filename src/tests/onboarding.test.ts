import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createScheduledTask,
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
import {
  __resetInjectedEnvTracking,
  _resetAutoReloadForTests,
  handleCore,
  loadGlobalConfigsIntoEnv,
} from "../http/core";
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
  "EMBEDDING_QUERY_PREFIX",
  "EMBEDDING_DOCUMENT_PREFIX",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_MODE",
  "COMB_ENABLED",
  "AGENT_FS_API_URL",
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
  await client.run("DELETE FROM scheduled_tasks");
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
  parentTaskId?: string | null;
  finishedAt?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    `INSERT INTO agent_tasks (
       id, task, status, source, taskType, requestedByUserId, parentTaskId, finishedAt,
       swarmVersion, createdAt, lastUpdatedAt
     ) VALUES (?, ?, ?, 'ui', ?, ?, ?, ?, '1.0.0', ?, ?)`,
    [
      options.id,
      `Task ${options.id}`,
      options.status ?? "in_progress",
      options.taskType ?? null,
      options.requestedByUserId ?? null,
      options.parentTaskId ?? null,
      options.finishedAt ?? null,
      now,
      now,
    ],
  );
}

/** A finish time before the follow-up window of the first task step, so only the tree decides. */
function longAgo(): string {
  return new Date(Date.now() - 60_000).toISOString();
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
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs.example.test";
    const response = await request("/api/onboarding");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      state: OnboardingState;
      signals: { files: { enabled: boolean } };
    };

    expect(body.signals.files).toEqual({ enabled: true });
    expect(body.state.steps.files).toEqual({
      status: "todo",
      at: null,
      method: null,
      errorClass: null,
    });

    expect(body.state.autoCompleted).toBe(false);
    expect(body.state.completedAt).toBeNull();
    expect(body.state.version).toBe(1);
  });

  test("a stored org name completes the name step, the old default does not", async () => {
    const nameStep = async () =>
      ((await (await request("/api/onboarding")).json()) as { state: OnboardingState }).state.steps
        .name;
    const previous = process.env.SWARM_ORG_NAME;
    try {
      delete process.env.SWARM_ORG_NAME;
      expect((await nameStep()).status).toBe("todo");
      process.env.SWARM_ORG_NAME = " Your Swarm ";
      expect((await nameStep()).status).toBe("todo");
      process.env.SWARM_ORG_NAME = "Acme";
      expect(await nameStep()).toMatchObject({ status: "done", method: "custom_name" });
      // Clearing the name later never undoes a done step.
      delete process.env.SWARM_ORG_NAME;
      expect((await nameStep()).status).toBe("done");
    } finally {
      if (previous === undefined) delete process.env.SWARM_ORG_NAME;
      else process.env.SWARM_ORG_NAME = previous;
    }
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

  test("a row stored before the files step back-fills it as todo", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs.example.test";
    const state = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
    };
    const stored = structuredClone(state.state) as unknown as {
      startedAt: string;
      steps: Record<string, unknown>;
    };
    stored.steps.integrations = {
      status: "skipped",
      at: stored.startedAt,
      method: null,
      errorClass: null,
    };
    delete stored.steps.files;
    await upsertSwarmConfig({
      scope: "global",
      key: "onboarding_state",
      value: JSON.stringify(stored),
    });

    const body = (await (await request("/api/onboarding")).json()) as { state: OnboardingState };
    expect(body.state.steps.integrations.status).toBe("skipped");
    expect(body.state.steps.files).toEqual({
      status: "todo",
      at: null,
      method: null,
      errorClass: null,
    });
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
      signals: { providers: unknown[]; embeddings: Record<string, unknown> };
    };

    expect(body.state.steps.connect).toMatchObject({ status: "done", method: "api_key" });
    expect(body.signals.providers).toEqual([]);
    expect(body.signals.embeddings).toEqual({
      configured: false,
      dimensions: 512,
      model: null,
      local: false,
      provider: null,
      localDefault: null,
    });
    expect((await getState()).steps.connect.status).toBe("done");
  });

  test("embedding signals name the model and say whether the endpoint is local", async () => {
    const cases: Array<[string | undefined, boolean, string]> = [
      ["http://tei:80/v1", true, "local"],
      ["http://localhost:8080/v1", true, "local"],
      ["http://127.0.0.1:8091/v1", true, "local"],
      ["http://10.0.4.2/v1", true, "local"],
      ["http://[::1]:8080/v1", true, "local"],
      ["https://api.openai.com/v1", false, "openai"],
      ["https://openrouter.ai/api/v1", false, "openrouter"],
      ["https://ai-gateway.vercel.sh/v1", false, "vercel"],
      ["https://my-resource.services.ai.azure.com/openai/v1", false, "azure"],
      ["http://[2001:db8::1]/v1", false, "custom"],
      [undefined, false, "openai"],
    ];
    process.env.EMBEDDING_API_KEY = "local-tei";
    process.env.EMBEDDING_MODEL = "nomic-ai/nomic-embed-text-v1.5";
    for (const [baseUrl, local, provider] of cases) {
      if (baseUrl === undefined) delete process.env.EMBEDDING_API_BASE_URL;
      else process.env.EMBEDDING_API_BASE_URL = baseUrl;
      const body = (await (await request("/api/onboarding")).json()) as {
        signals: { embeddings: Record<string, unknown> };
      };
      expect({ baseUrl, embeddings: body.signals.embeddings }).toEqual({
        baseUrl,
        embeddings: {
          configured: true,
          dimensions: 512,
          model: "nomic-ai/nomic-embed-text-v1.5",
          local,
          provider,
          // The environment is the deployment's: a local endpoint is its local default.
          localDefault: local ? { model: "nomic-ai/nomic-embed-text-v1.5" } : null,
        },
      });
      // The signal never carries the key or the URL.
      expect(JSON.stringify(body.signals.embeddings)).not.toContain("local-tei");
      if (baseUrl) expect(JSON.stringify(body.signals.embeddings)).not.toContain(baseUrl);
    }

    // No model set: the provider's default model.
    delete process.env.EMBEDDING_MODEL;
    const fallback = (await (await request("/api/onboarding")).json()) as {
      signals: { embeddings: { model: string | null } };
    };
    expect(fallback.signals.embeddings.model).toBe("text-embedding-3-small");
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
      {
        provider: "claude",
        state: "verified",
        workers: 2,
        verifiedWorkers: 2,
        error: null,
        warning: null,
      },
    ]);
    expect(body.state.steps.ai).toMatchObject({
      status: "done",
      method: "claude_setup_token",
    });
  });

  test("GET carries the latest live test error and the pool warning", async () => {
    const report = (liveTest: {
      ok: boolean;
      error: string | null;
      latency_ms: number;
      testedAt: number;
      warning?: string;
    }) => ({
      ready: true,
      missing: [],
      satisfiedBy: "env" as const,
      hint: null,
      liveTest,
      reportedAt: Date.now(),
      reportKind: "boot" as const,
    });
    const failing = await createAgent({ name: "codex-worker", isLead: false, status: "idle" });
    await setAgentHarnessProvider(failing.id, "codex");
    await updateAgentCredStatus(
      failing.id,
      report({ ok: false, error: "HTTP 401: bad key", latency_ms: 5, testedAt: Date.now() }),
    );
    const warned = await createAgent({ name: "pi-worker", isLead: false, status: "idle" });
    await setAgentHarnessProvider(warned.id, "pi");
    await updateAgentCredStatus(
      warned.id,
      report({
        ok: true,
        error: null,
        latency_ms: 5,
        testedAt: Date.now(),
        warning: "1 of 2 keys failed: key ending abcde (HTTP 401).",
      }),
    );

    const body = (await (await request("/api/onboarding")).json()) as {
      signals: { providers: Array<Record<string, unknown>> };
    };
    const byProvider = Object.fromEntries(body.signals.providers.map((p) => [p.provider, p]));
    expect(byProvider.codex).toMatchObject({
      state: "configured",
      error: "HTTP 401: bad key",
      warning: null,
    });
    expect(byProvider.pi).toMatchObject({
      state: "verified",
      error: null,
      warning: "1 of 2 keys failed: key ending abcde (HTTP 401).",
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

  test("GET derives the Bitbucket integration from BITBUCKET_TOKEN", async () => {
    process.env.BITBUCKET_TOKEN = "example-bitbucket-token";
    const body = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
      signals: { integrations: Record<string, boolean> };
    };

    expect(body.signals.integrations.bitbucket).toBe(true);
    expect(body.state.steps.integrations).toMatchObject({ status: "done", method: "bitbucket" });
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

    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?",
      [longAgo(), "first-task"],
    );
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
    await insertTask({ id: "already-completed", status: "completed", finishedAt: longAgo() });

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

  describe("first task tree", () => {
    async function selectFirstTask(taskId: string): Promise<OnboardingState> {
      const response = await put({ action: "first_task", taskId, method: "free_form" });
      expect(response.status).toBe(200);
      return ((await response.json()) as { state: OnboardingState }).state;
    }

    async function readState(): Promise<OnboardingState> {
      return ((await (await request("/api/onboarding")).json()) as { state: OnboardingState })
        .state;
    }

    async function firstTaskEvents(): Promise<string[]> {
      await Bun.sleep(10);
      return capturedTelemetry
        .map((entry) => entry.event)
        .filter((event) => event === "first_task_completed" || event === "completed");
    }

    test("a completed root with an open task under it is not done, until the tree settles", async () => {
      await request("/api/onboarding");
      // The lead completes the root task when it delegates. The worker's
      // result goes to a lead follow-up, a grandchild of the root.
      await insertTask({ id: "root", status: "completed", finishedAt: longAgo() });
      await insertTask({
        id: "worker",
        status: "completed",
        parentTaskId: "root",
        finishedAt: longAgo(),
      });
      await insertTask({ id: "lead-follow-up", status: "pending", parentTaskId: "worker" });

      let state = await selectFirstTask("root");
      expect(state.steps.first_task.status).toBe("todo");
      expect(state.completedAt).toBeNull();
      await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
        "lead-follow-up",
      ]);
      state = await readState();
      expect(state.steps.first_task.status).toBe("todo");
      expect(await firstTaskEvents()).toEqual([]);

      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?",
        [longAgo(), "lead-follow-up"],
      );
      state = await readState();
      expect(state.steps.first_task).toMatchObject({ status: "done", method: "free_form" });
      expect(state.completedAt).not.toBeNull();
      expect(await firstTaskEvents()).toEqual(["first_task_completed", "completed"]);
    });

    test("a failed or cancelled task in the tree counts as settled", async () => {
      await request("/api/onboarding");
      await insertTask({ id: "root", status: "completed", finishedAt: longAgo() });
      await insertTask({
        id: "failed-child",
        status: "failed",
        parentTaskId: "root",
        finishedAt: longAgo(),
      });
      await insertTask({
        id: "cancelled-child",
        status: "cancelled",
        parentTaskId: "root",
        finishedAt: longAgo(),
      });
      await insertTask({
        id: "running-child",
        status: "in_progress",
        parentTaskId: "root",
      });

      expect((await selectFirstTask("root")).steps.first_task.status).toBe("todo");

      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'completed', finishedAt = ? WHERE id = ?",
        [longAgo(), "running-child"],
      );
      expect((await readState()).steps.first_task.status).toBe("done");
    });

    test("a task that just finished holds the step while its follow-up can still appear", async () => {
      await request("/api/onboarding");
      await insertTask({ id: "root", status: "completed", finishedAt: longAgo() });
      await insertTask({
        id: "worker",
        status: "completed",
        parentTaskId: "root",
        finishedAt: new Date().toISOString(),
      });

      expect((await selectFirstTask("root")).steps.first_task.status).toBe("todo");

      await getDbClient().run("UPDATE agent_tasks SET finishedAt = ? WHERE id = ?", [
        longAgo(),
        "worker",
      ]);
      expect((await readState()).steps.first_task.status).toBe("done");
    });

    test("a deferral that waits to wake up holds the step", async () => {
      await request("/api/onboarding");
      await insertTask({ id: "root", status: "completed", finishedAt: longAgo() });
      const schedule = await createScheduledTask({
        name: `deferred-root-${crypto.randomUUID()}`,
        taskTemplate: "Resume task root: check the result.",
        targetType: "agent-task",
        scheduleType: "one_time",
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        taskType: "deferred",
        tags: ["deferred"],
        parentTaskId: "root",
      });

      expect((await selectFirstTask("root")).steps.first_task.status).toBe("todo");

      await getDbClient().run("UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?", [schedule.id]);
      expect((await readState()).steps.first_task.status).toBe("done");
    });
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

  test("without Comb the files step reads as skipped, unpersisted and with no event", async () => {
    const first = (await (await request("/api/onboarding")).json()) as {
      state: OnboardingState;
      signals: { files: { enabled: boolean } };
    };
    expect(first.signals.files).toEqual({ enabled: false });
    expect(first.state.steps.files.status).toBe("skipped");
    // A write for another step persists the row: files must stay todo in storage.
    expect((await put({ action: "skip", step: "name" })).status).toBe(200);
    expect((await getState()).steps.files.status).toBe("todo");
    await Bun.sleep(10);
    expect(
      capturedTelemetry.filter(
        (entry) => entry.event === "step_skipped" && entry.properties.step === "files",
      ),
    ).toHaveLength(0);

    // Turning Comb on brings the step back.
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs.example.test";
    const after = (await (await request("/api/onboarding")).json()) as { state: OnboardingState };
    expect(after.state.steps.files.status).toBe("todo");
  });

  test("PUT completes the files step with created or connected", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs.example.test";
    await request("/api/onboarding");
    capturedTelemetry.length = 0;

    const created = await put({ action: "complete", step: "files", method: "created" });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { state: OnboardingState }).state.steps.files).toMatchObject({
      status: "done",
      method: "created",
    });
    await Bun.sleep(10);
    expect(capturedTelemetry).toContainEqual(
      expect.objectContaining({
        event: "step_completed",
        properties: expect.objectContaining({ step: "files", method: "created" }),
      }),
    );

    const connected = await put({ action: "complete", step: "files", method: "connected" });
    expect(connected.status).toBe(200);
    expect((await getState()).steps.files).toMatchObject({ status: "done", method: "connected" });
  });

  test("a completed files step stays done when Comb is off", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs.example.test";
    await put({ action: "complete", step: "files", method: "connected" });
    process.env.COMB_ENABLED = "false";
    const body = (await (await request("/api/onboarding")).json()) as { state: OnboardingState };
    expect(body.state.steps.files).toMatchObject({ status: "done", method: "connected" });
  });

  test("PUT rejects a bad completion method and connect skip", async () => {
    expect((await put({ action: "complete", step: "files", method: "pasted" })).status).toBe(400);
    expect((await put({ action: "complete", step: "files", method: "api_key" })).status).toBe(400);
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

  test("only an openrouter.ai endpoint gets OpenRouter app attribution", async () => {
    const referers: Record<string, string | null> = {};
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        referers.local = req.headers.get("http-referer");
        return embeddingResponse(512);
      },
    });
    const origFetch = globalThis.fetch;
    // The probe builds a fresh OpenAI client per call, which picks up this stub.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      if (new URL(req.url).hostname !== "openrouter.ai") return origFetch(input, init);
      referers[process.env.OPENROUTER_APP_ATTRIBUTION ? "optedOut" : "openrouter"] =
        req.headers.get("http-referer");
      return embeddingResponse(512);
    }) as typeof fetch;
    const probe = (body: Record<string, unknown>) =>
      request("/api/onboarding/memory", {
        method: "POST",
        body: { model: "test-embedding-model", apiKey: "example-key", ...body },
      });
    try {
      expect((await probe({ preset: "openrouter" })).status).toBe(200);
      process.env.OPENROUTER_APP_ATTRIBUTION = "false";
      expect((await probe({ preset: "openrouter" })).status).toBe(200);
      delete process.env.OPENROUTER_APP_ATTRIBUTION;
      expect(
        (await probe({ preset: "custom", baseUrl: `http://127.0.0.1:${fake.port}/v1` })).status,
      ).toBe(200);
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.OPENROUTER_APP_ATTRIBUTION;
      fake.stop(true);
    }
    expect(referers).toEqual({
      openrouter: "https://agent-swarm.dev",
      optedOut: null,
      local: null,
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

  test("splits a 404 into a missing path and a missing model or deployment", async () => {
    const cases = [
      {
        // Azure without `/openai/v1`.
        body: { error: { code: "404", message: "Resource not found" } },
        errorClass: "endpoint",
        error: "The endpoint path was not found (404). Check the base URL.",
      },
      {
        // A proxy or server page with no JSON body.
        body: "404 page not found",
        errorClass: "endpoint",
        error: "The endpoint path was not found (404). Check the base URL.",
      },
      {
        body: {
          error: {
            message: "The model `nope` does not exist or you do not have access to it.",
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        errorClass: "model",
        error: "The endpoint could not find the embedding model or deployment (404).",
      },
      {
        body: {
          error: {
            code: "DeploymentNotFound",
            message: "The API deployment for this resource does not exist.",
          },
        },
        errorClass: "model",
        error: "The endpoint could not find the embedding model or deployment (404).",
      },
    ] as const;

    for (const testCase of cases) {
      const fake = startEmbeddingServer(() =>
        typeof testCase.body === "string"
          ? new Response(testCase.body, { status: 404 })
          : Response.json(testCase.body, { status: 404 }),
      );
      try {
        const response = await request("/api/onboarding/memory", {
          method: "POST",
          body: {
            preset: "azure",
            baseUrl: fake.baseUrl,
            model: "my-embedding-deployment",
            apiKey: "azure-resource-key",
          },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ok: false,
          errorClass: testCase.errorClass,
          error: testCase.error,
        });
      } finally {
        fake.server.stop(true);
      }
    }
    // A failed step keeps its first error class.
    expect((await getState()).steps.memory).toMatchObject({
      status: "failed",
      errorClass: "endpoint",
    });
  });

  test("the azure preset saves its base URL and deployment name", async () => {
    let path = "";
    let model = "";
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        path = new URL(req.url).pathname;
        model = ((await req.json()) as { model: string }).model;
        return embeddingResponse(512);
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${fake.port}/openai/v1`;
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "azure",
          baseUrl,
          model: "my-embedding-deployment",
          apiKey: "azure-resource-key",
        },
      });
      expect(await response.json()).toMatchObject({ ok: true, dimensions: 512 });
      expect(path).toBe("/openai/v1/embeddings");
      expect(model).toBe("my-embedding-deployment");
      const configs = await getSwarmConfigs({ scope: "global" });
      const saved = Object.fromEntries(configs.map((config) => [config.key, config.value]));
      expect(saved).toMatchObject({
        EMBEDDING_API_BASE_URL: baseUrl,
        EMBEDDING_MODEL: "my-embedding-deployment",
      });
      expect((await getState()).steps.memory).toMatchObject({ status: "done", method: "azure" });
    } finally {
      fake.stop(true);
    }
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

  test("probes and saves the first member of a reused OpenAI pool", async () => {
    const originalFetch = globalThis.fetch;
    let authorization: string | null = null;
    process.env.OPENAI_API_KEY = "example-first, example-second";
    globalThis.fetch = (async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).hostname !== "api.openai.com") return originalFetch(input, init);
      authorization = req.headers.get("authorization");
      return embeddingResponse(512);
    }) as typeof fetch;
    try {
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: { preset: "openai", reuseKey: "OPENAI_API_KEY" },
      });
      expect(await response.json()).toMatchObject({ ok: true, dimensions: 512 });
      expect(authorization).toBe("Bearer example-first");
      const configs = await getSwarmConfigs({ scope: "global", key: "EMBEDDING_API_KEY" });
      expect(configs[0]?.value).toBe("example-first");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const keyVar of ["EMBEDDING_API_KEY", "OPENAI_API_KEY"]) {
    test(`existing memory probes the first member of ${keyVar}`, async () => {
      const originalFetch = globalThis.fetch;
      let authorization: string | null = null;
      process.env[keyVar] = "example-first, example-second";
      process.env.EMBEDDING_API_BASE_URL = "https://api.openai.com/v1";
      globalThis.fetch = (async (input, init) => {
        const req = new Request(input, init);
        if (new URL(req.url).hostname !== "api.openai.com") return originalFetch(input, init);
        authorization = req.headers.get("authorization");
        return embeddingResponse(512);
      }) as typeof fetch;
      try {
        const response = await request("/api/onboarding/memory", {
          method: "POST",
          body: { preset: "existing" },
        });
        expect(await response.json()).toMatchObject({ ok: true, dimensions: 512 });
        expect(authorization).toBe("Bearer example-first");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

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

  test("existing preset probes a private configured endpoint outside local development", async () => {
    let hits = 0;
    const fake = startEmbeddingServer(() => {
      hits += 1;
      return embeddingResponse(512);
    });
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.EMBEDDING_API_BASE_URL = fake.baseUrl;
    process.env.EMBEDDING_MODEL = "test-embedding-model";
    process.env.EMBEDDING_API_KEY = "local-tei";
    try {
      const existing = await request("/api/onboarding/memory", {
        method: "POST",
        body: { preset: "existing" },
      });
      expect(await existing.json()).toMatchObject({ ok: true, dimensions: 512 });
      expect(hits).toBe(1);

      // The same private URL from the request body is still blocked.
      const custom = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "custom",
          baseUrl: fake.baseUrl,
          model: "test-embedding-model",
          apiKey: "local-tei",
        },
      });
      expect(await custom.json()).toMatchObject({
        ok: false,
        errorClass: "network",
        error: "The endpoint URL is not allowed.",
      });
      expect(hits).toBe(1);
    } finally {
      fake.server.stop(true);
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("existing preset with no configured endpoint keeps the SSRF check", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.EMBEDDING_API_KEY = "local-tei";
    try {
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: { preset: "existing", baseUrl: "http://127.0.0.1:9/v1" },
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

describe("onboarding memory: the deployment's local setup", () => {
  const NOMIC = "nomic-ai/nomic-embed-text-v1.5";

  /** The bundled install: a local endpoint, its model, a key, and nomic's task prefixes. */
  function setDeploymentEnv(localUrl: string) {
    process.env.EMBEDDING_API_BASE_URL = localUrl;
    process.env.EMBEDDING_MODEL = NOMIC;
    process.env.EMBEDDING_API_KEY = "local-tei";
    process.env.EMBEDDING_QUERY_PREFIX = "search_query: ";
    process.env.EMBEDDING_DOCUMENT_PREFIX = "search_document: ";
  }

  async function storedEmbeddingRows(): Promise<Record<string, string>> {
    const rows = await getSwarmConfigs({ scope: "global" });
    return Object.fromEntries(
      rows.filter((row) => row.key.startsWith("EMBEDDING_")).map((row) => [row.key, row.value]),
    );
  }

  async function embeddingSignals(): Promise<Record<string, unknown>> {
    const body = (await (await request("/api/onboarding")).json()) as {
      signals: { embeddings: Record<string, unknown> };
    };
    return body.signals.embeddings;
  }

  test("a hosted save stores empty prefixes over the local model's prefixes", async () => {
    const hosted = startEmbeddingServer(() => embeddingResponse(512));
    setDeploymentEnv("http://tei:80/v1");
    try {
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "custom",
          baseUrl: hosted.baseUrl,
          model: "test-embedding-model",
          apiKey: "example-hosted-key",
        },
      });
      expect(await response.json()).toMatchObject({ ok: true });
      expect(await storedEmbeddingRows()).toEqual({
        EMBEDDING_API_BASE_URL: hosted.baseUrl,
        EMBEDDING_MODEL: "test-embedding-model",
        EMBEDDING_API_KEY: "example-hosted-key",
        EMBEDDING_QUERY_PREFIX: "",
        EMBEDDING_DOCUMENT_PREFIX: "",
      });

      // The deployment's own model keeps its prefixes: the empty rows go.
      const same = await request("/api/onboarding/memory", {
        method: "POST",
        body: { preset: "custom", baseUrl: hosted.baseUrl, model: NOMIC, apiKey: "example-key" },
      });
      expect(await same.json()).toMatchObject({ ok: true });
      const rows = await storedEmbeddingRows();
      expect(rows.EMBEDDING_QUERY_PREFIX).toBeUndefined();
      expect(rows.EMBEDDING_DOCUMENT_PREFIX).toBeUndefined();
    } finally {
      hosted.server.stop(true);
    }
  });

  test("without deployment prefixes a hosted save stores none", async () => {
    const hosted = startEmbeddingServer(() => embeddingResponse(512));
    try {
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: {
          preset: "custom",
          baseUrl: hosted.baseUrl,
          model: "test-embedding-model",
          apiKey: "example-hosted-key",
        },
      });
      expect(await response.json()).toMatchObject({ ok: true });
      expect(Object.keys(await storedEmbeddingRows()).sort()).toEqual([
        "EMBEDDING_API_BASE_URL",
        "EMBEDDING_API_KEY",
        "EMBEDDING_MODEL",
      ]);
    } finally {
      hosted.server.stop(true);
    }
  });

  test("a stored hosted setup keeps the local default, and restore brings it back", async () => {
    let localHits = 0;
    const local = startEmbeddingServer(() => {
      localHits += 1;
      return embeddingResponse(512);
    });
    setDeploymentEnv(local.baseUrl);
    try {
      // A hosted setup stored earlier, applied as the boot or a reload does.
      await upsertSwarmConfig({
        scope: "global",
        key: "EMBEDDING_API_BASE_URL",
        value: "https://openrouter.ai/api/v1",
      });
      await upsertSwarmConfig({
        scope: "global",
        key: "EMBEDDING_MODEL",
        value: "google/gemini-embedding-2",
      });
      await upsertSwarmConfig({
        scope: "global",
        key: "EMBEDDING_API_KEY",
        value: "example-openrouter-key",
        isSecret: true,
      });
      await upsertSwarmConfig({ scope: "global", key: "EMBEDDING_QUERY_PREFIX", value: "" });
      await upsertSwarmConfig({ scope: "global", key: "EMBEDDING_DOCUMENT_PREFIX", value: "" });
      await loadGlobalConfigsIntoEnv(true);
      resetEmbeddingProvider();

      expect(await embeddingSignals()).toEqual({
        configured: true,
        dimensions: 512,
        model: "google/gemini-embedding-2",
        local: false,
        provider: "openrouter",
        localDefault: { model: NOMIC },
      });

      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: { preset: "existing", restoreDefault: true },
      });
      expect(await response.json()).toMatchObject({ ok: true, dimensions: 512 });
      // It tested the deployment's endpoint, not the stored one.
      expect(localHits).toBe(1);
      expect(await storedEmbeddingRows()).toEqual({});
      expect(process.env.EMBEDDING_API_BASE_URL).toBe(local.baseUrl);
      expect(process.env.EMBEDDING_QUERY_PREFIX).toBe("search_query: ");
      expect(await embeddingSignals()).toMatchObject({
        model: NOMIC,
        local: true,
        provider: "local",
        localDefault: { model: NOMIC },
      });
      expect((await getState()).steps.memory).toMatchObject({ status: "done", method: "existing" });
    } finally {
      local.server.stop(true);
      __resetInjectedEnvTracking();
    }
  });

  test("a stored private endpoint keeps the SSRF check", async () => {
    let hits = 0;
    const stored = startEmbeddingServer(() => {
      hits += 1;
      return embeddingResponse(512);
    });
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    setDeploymentEnv("https://embeddings.example.com/v1");
    try {
      // A config writer stores a loopback URL over the deployment's endpoint.
      await upsertSwarmConfig({
        scope: "global",
        key: "EMBEDDING_API_BASE_URL",
        value: stored.baseUrl,
      });
      await loadGlobalConfigsIntoEnv(true);
      expect(process.env.EMBEDDING_API_BASE_URL).toBe(stored.baseUrl);
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: { preset: "existing" },
      });
      expect(await response.json()).toMatchObject({
        ok: false,
        errorClass: "network",
        error: "The endpoint URL is not allowed.",
      });
      expect(hits).toBe(0);
    } finally {
      stored.server.stop(true);
      __resetInjectedEnvTracking();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("a failed restore test keeps the stored setup", async () => {
    const local = startEmbeddingServer(() => new Response("model loading", { status: 503 }));
    setDeploymentEnv(local.baseUrl);
    try {
      await upsertSwarmConfig({ scope: "global", key: "EMBEDDING_MODEL", value: "stored-model" });
      await loadGlobalConfigsIntoEnv(true);
      const response = await request("/api/onboarding/memory", {
        method: "POST",
        body: { preset: "existing", restoreDefault: true },
      });
      expect(await response.json()).toMatchObject({ ok: false });
      expect(await storedEmbeddingRows()).toEqual({ EMBEDDING_MODEL: "stored-model" });
      expect(process.env.EMBEDDING_MODEL).toBe("stored-model");
    } finally {
      local.server.stop(true);
      __resetInjectedEnvTracking();
    }
  });

  test("restoreDefault needs the existing preset", async () => {
    const response = await request("/api/onboarding/memory", {
      method: "POST",
      body: {
        preset: "custom",
        baseUrl: "https://embeddings.example.com/v1",
        restoreDefault: true,
      },
    });
    expect(response.status).toBe(400);
  });
});
