import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDbClient,
  getLatestScriptRunStepTaskByContextKey,
  getLatestTaskByContextKey,
  getPendingTaskForAgent,
  initDb,
  updateScriptRun,
} from "../be/db";
import { configSecretName, registerStoredSecret } from "../be/secret-registry";
import { handleCore } from "../http/core";
import { handleScriptRuns } from "../http/script-runs";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { localProcessScriptExecutor } from "../script-workflows/executor";
import { setScriptRunExecutor } from "../script-workflows/supervisor";
import type { AgentTask } from "../types";
import {
  clearVolatileSecretsForTesting,
  refreshSecretScrubberCache,
} from "../utils/secret-scrubber";
import { executeRawLlm } from "../workflows/executors/raw-llm";
import { randomToken } from "./synthetic-secret-helpers";

const TEST_DB_PATH = "./test-script-runs-http.sqlite";
const API_KEY = "example-test-script-runs-http-key-1234567890";

let agentId: string;
let savedEnv: NodeJS.ProcessEnv;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  process.env.APP_URL = "https://app.example.test";
  process.env.SCRIPT_RUN_SUPERVISOR_DISABLE = "true";
  delete process.env.API_KEY;
  refreshSecretScrubberCache();

  const agent = await createAgent({ name: "script-runs-worker", isLead: false, status: "idle" });
  agentId = agent.id;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM script_run_journal");
  await client.run("DELETE FROM script_runs");
  delete process.env.SCRIPT_RUN_CONCURRENCY_CAP;
  delete process.env.SCRIPT_RUN_MAX_STEPS;
  delete process.env.SCRIPT_RUN_MAX_AGENT_TASKS;
  delete process.env.SCRIPT_RUN_MAX_WALL_MS;
  process.env.SCRIPT_RUN_SUPERVISOR_DISABLE = "true";
});

type TestResponse = {
  status: number;
  text: string;
  json: () => Promise<unknown>;
};

async function dispatch(
  path: string,
  init: RequestInit & { agentId?: string } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.agentId !== undefined) headers["X-Agent-ID"] = init.agentId;
  const req = Readable.from(init.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const requestAgentId = req.headers["x-agent-id"] as string | undefined;
  if (!(await handleCore(req, res, requestAgentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (!(await handleScriptRuns(req, res, pathSegments, queryParams, requestAgentId))) {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  return {
    status,
    text,
    json: async () => JSON.parse(text),
  };
}

function createBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: "export default async function main() { return { ok: true }; }",
    args: { ok: true },
    ...extra,
  });
}

describe("/api/script-runs HTTP", () => {
  test("creates and lists a script run", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody({ scriptName: "daily-report" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; status: string; url: string };
    expect(body.status).toBe("running");
    expect(body.url).toBe(`https://app.example.test/script-runs/${body.id}`);

    const listed = await dispatch("/api/script-runs", { agentId });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      runs: Array<{ id: string; source?: string; args?: unknown; output?: unknown }>;
      total: number;
    };
    expect(listBody.total).toBe(1);
    expect(listBody.runs[0]?.id).toBe(body.id);
    expect(listBody.runs[0]?.source).toBeUndefined();
    expect(listBody.runs[0]?.args).toBeUndefined();
    expect(listBody.runs[0]?.output).toBeUndefined();
  });

  test("background runs call back through MCP_BASE_URL, not the public base URL", async () => {
    process.env.SCRIPT_RUN_SUPERVISOR_DISABLE = "false";
    process.env.MCP_BASE_URL = "http://swarm-internal.example.test:3013";
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm-public.example.test";
    const spawnedWith: string[] = [];
    setScriptRunExecutor({
      async start({ baseUrl }) {
        spawnedWith.push(baseUrl);
        return {
          pid: null,
          tmpdir: "",
          startedAtMs: Date.now(),
          exited: new Promise(() => {}),
          terminate: async () => {},
          cleanup: async () => {},
        };
      },
      isRunning: () => false,
      terminatePid: async () => {},
    });

    try {
      const created = await dispatch("/api/script-runs", {
        method: "POST",
        agentId,
        body: createBody({ background: true }),
      });
      expect(created.status).toBe(201);
      // The launch is fire-and-forget and reads the sealed args before it
      // starts the executor, so it can land after the response.
      for (let i = 0; i < 50 && spawnedWith.length === 0; i++) {
        await Bun.sleep(20);
      }
      expect(spawnedWith).toEqual(["http://swarm-internal.example.test:3013"]);
    } finally {
      setScriptRunExecutor(localProcessScriptExecutor);
      delete process.env.MCP_BASE_URL;
      delete process.env.PUBLIC_MCP_BASE_URL;
    }
  });

  test("returns the existing run for an idempotency key", async () => {
    const first = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody({ idempotencyKey: "stable-key" }),
    });
    const firstBody = (await first.json()) as { id: string };

    const second = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody({ idempotencyKey: "stable-key" }),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);
  });

  test("rejects obvious literal labels inside loops before launch", async () => {
    const rejected = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody({
        source:
          'export default async function main(args, ctx) { for (const item of args.items) { await ctx.step.agentTask("process", { task: item.task }); } }',
      }),
    });
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as { error: string; violations: Array<{ label: string }> };
    expect(body.error).toBe("label_lint_violation");
    expect(body.violations[0]?.label).toBe("process");
  });

  test("records and replays journal steps through internal routes", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id } = (await created.json()) as { id: string };

    const recorded = await dispatch(`/api/internal/script-runs/${id}/steps`, {
      method: "POST",
      agentId,
      body: JSON.stringify({
        stepKey: "summarize",
        stepType: "raw-llm",
        config: { prompt: "hello" },
        status: "completed",
        result: { text: "hi" },
      }),
    });
    expect(recorded.status).toBe(201);

    const replayed = await dispatch(`/api/internal/script-runs/${id}/steps/summarize`, {
      agentId,
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({
      stepKey: "summarize",
      stepType: "raw-llm",
      status: "completed",
      result: { text: "hi" },
    });
  });

  test("exposes journal status and error so a failed step can be replayed as a failure", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id } = (await created.json()) as { id: string };

    const recorded = await dispatch(`/api/internal/script-runs/${id}/steps`, {
      method: "POST",
      agentId,
      body: JSON.stringify({
        stepKey: "implement",
        stepType: "agent-task",
        config: { task: "do it" },
        status: "failed",
        error: "agent-task implement failed: Agent task failed (taskId task-9)",
      }),
    });
    expect(recorded.status).toBe(201);

    const replayed = await dispatch(`/api/internal/script-runs/${id}/steps/implement`, {
      agentId,
    });
    expect(replayed.status).toBe(200);
    // Without these two fields the harness replays a failed step as a
    // successful `undefined` and the workflow completes past a failed child.
    expect(await replayed.json()).toEqual({
      stepKey: "implement",
      stepType: "agent-task",
      status: "failed",
      error: "agent-task implement failed: Agent task failed (taskId task-9)",
    });
  });

  test("redacts journal config/error and run output/error posted by the harness", async () => {
    const token = ["ghp", randomToken(36)].join("_");
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id } = (await created.json()) as { id: string };

    const recorded = await dispatch(`/api/internal/script-runs/${id}/steps`, {
      method: "POST",
      agentId,
      body: JSON.stringify({
        stepKey: "deploy",
        stepType: "agent-task",
        config: { task: `deploy with ${token}` },
        status: "failed",
        error: `deploy failed: bad credential ${token}`,
      }),
    });
    expect(recorded.status).toBe(201);
    const step = await getDbClient().get<{ config: string; error: string }>(
      "SELECT config, error FROM script_run_journal WHERE runId = ?",
      [id],
    );
    for (const value of [step?.config, step?.error]) {
      expect(value).toBeString();
      expect(value!.includes(token)).toBe(false);
      expect(value!).toContain("[REDACTED:");
    }
    expect(step!.error).toContain("deploy failed: bad credential");
    expect((JSON.parse(step!.config) as { task: string }).task).toContain("deploy with");

    await updateScriptRun(id, { status: "running" });
    const status = await dispatch(`/api/internal/script-runs/${id}/status`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ status: "failed", error: `exit: ${token}` }),
    });
    expect(status.status).toBe(204);
    const run = await getDbClient().get<{ error: string }>(
      "SELECT error FROM script_runs WHERE id = ?",
      [id],
    );
    expect(run!.error.includes(token)).toBe(false);
    expect(run!.error).toContain("exit: [REDACTED:");
  });

  test("aborts the run when the journal step cap is exceeded", async () => {
    process.env.SCRIPT_RUN_MAX_STEPS = "1";
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id } = (await created.json()) as { id: string };

    const first = await dispatch(`/api/internal/script-runs/${id}/steps`, {
      method: "POST",
      agentId,
      body: JSON.stringify({
        stepKey: "one",
        stepType: "swarm-script",
        status: "completed",
        result: 1,
      }),
    });
    expect(first.status).toBe(201);

    const second = await dispatch(`/api/internal/script-runs/${id}/steps`, {
      method: "POST",
      agentId,
      body: JSON.stringify({
        stepKey: "two",
        stepType: "swarm-script",
        status: "completed",
        result: 2,
      }),
    });
    expect(second.status).toBe(429);

    const detail = await dispatch(`/api/script-runs/${id}`, { agentId });
    const body = (await detail.json()) as { run: { status: string; error?: string } };
    expect(body.run.status).toBe("aborted_limit");
    expect(body.run.error).toContain("SCRIPT_RUN_MAX_STEPS");
  });

  test("SCRIPT_RUN_MAX_AGENT_TASKS is enforced across concurrent dispatches, not just sequential ones", async () => {
    // Simulates N ctx.step.agentTask calls journaling near-simultaneously
    // via Promise.all inside a workflow. The cap check re-reads the DB
    // count synchronously right after each write (no await in between), so
    // concurrent journal writes for the same run don't under-count each
    // other even though their HTTP request parsing interleaves.
    process.env.SCRIPT_RUN_MAX_AGENT_TASKS = "3";
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id } = (await created.json()) as { id: string };

    const responses = await Promise.all(
      ["t1", "t2", "t3", "t4", "t5"].map((stepKey) =>
        dispatch(`/api/internal/script-runs/${id}/steps`, {
          method: "POST",
          agentId,
          body: JSON.stringify({
            stepKey,
            stepType: "agent-task",
            status: "completed",
            result: { taskId: stepKey },
          }),
        }),
      ),
    );

    const okCount = responses.filter((r) => r.status === 201).length;
    const limitedCount = responses.filter((r) => r.status === 429).length;
    expect(okCount).toBe(3);
    expect(limitedCount).toBe(2);

    const detail = await dispatch(`/api/script-runs/${id}`, { agentId });
    const body = (await detail.json()) as { run: { status: string; error?: string } };
    expect(body.run.status).toBe("aborted_limit");
    expect(body.run.error).toContain("SCRIPT_RUN_MAX_AGENT_TASKS");
  });

  test("agent-task dispatch is idempotent by (runId, stepKey) — the replay-safety guarantee ctx.step.agentTask relies on", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id: runId } = (await created.json()) as { id: string };

    // Kick off the first call without awaiting yet — the endpoint's poll loop
    // blocks until the task is terminal or 30s elapses, so complete the task
    // out-of-band (as a real worker would) while it's in flight.
    const firstCallPromise = dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ stepKey: "implement", task: "do the thing" }),
    });

    await Bun.sleep(50);
    const contextKey = `script-run:${runId}:implement`;
    const dispatched = await getLatestScriptRunStepTaskByContextKey(contextKey);
    expect(dispatched).not.toBeNull();
    await completeTask((dispatched as { id: string }).id, JSON.stringify({ done: true }));

    const first = await firstCallPromise;
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { taskId: string; taskOutput: unknown };
    expect(firstBody.taskId).toBe((dispatched as { id: string }).id);

    await Bun.sleep(2);
    const followUp = await createTaskExtended("review the completed step", {
      taskType: "follow-up",
      source: "system",
      parentTaskId: dispatched?.id,
    });
    await completeTask(followUp.id, "reviewed");
    expect((await getLatestTaskByContextKey(contextKey))?.id).toBe(followUp.id);

    // Replay: same stepKey again (what ctx.step.agentTask's poll loop does,
    // and what a resumed harness process does after a crash mid-wait). Must
    // resolve the SAME task, never create a second one.
    const second = await dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ stepKey: "implement", task: "do the thing" }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { taskId: string; taskOutput: unknown };
    expect(secondBody.taskId).toBe((dispatched as { id: string }).id);
    expect(secondBody.taskOutput).toBe(JSON.stringify({ done: true }));

    const stepCount = (await getDbClient().get<{ c: number }>(
      "SELECT COUNT(*) as c FROM agent_tasks WHERE contextKey = ? AND taskType = 'script-run-step'",
      [contextKey],
    )) as { c: number };
    expect(stepCount.c).toBe(1);
  });

  test.each([
    undefined,
    "skill",
  ] as const)("agent-task dispatch preserves author pins and routing provenance for %s", async (routingReason) => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id: runId } = (await created.json()) as { id: string };

    const responsePromise = dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ stepKey: "pinned", task: "do pinned work", agentId, routingReason }),
    });

    let dispatched = await getLatestScriptRunStepTaskByContextKey(`script-run:${runId}:pinned`);
    for (let i = 0; i < 50 && !dispatched; i++) {
      await Bun.sleep(20);
      dispatched = await getLatestScriptRunStepTaskByContextKey(`script-run:${runId}:pinned`);
    }
    expect(dispatched).not.toBeNull();
    await completeTask(dispatched!.id, "done");
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const { taskId } = (await response.json()) as { taskId: string };
    expect(
      await getDbClient().get(
        "SELECT agentId, routing_reason, routing_source FROM agent_tasks WHERE id = ?",
        [taskId],
      ),
    ).toEqual({
      agentId,
      routing_reason: routingReason ?? "human_pinned",
      routing_source: routingReason ? "declared" : "engine_default",
    });
  });

  async function dispatchStepFor(
    stepKey: string,
    stepAgentId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ response: Promise<TestResponse>; task: AgentTask }> {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id: runId } = (await created.json()) as { id: string };
    const response = dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ stepKey, task: `do ${stepKey}`, agentId: stepAgentId, ...extra }),
    });
    const contextKey = `script-run:${runId}:${stepKey}`;
    let task = await getLatestScriptRunStepTaskByContextKey(contextKey);
    for (let i = 0; i < 50 && !task; i++) {
      await Bun.sleep(20);
      task = await getLatestScriptRunStepTaskByContextKey(contextKey);
    }
    expect(task).not.toBeNull();
    return { response, task: task! };
  }

  test("agent-task dispatch persists dependsOn and holds the task until the dependency completes", async () => {
    const stepAgent = await createAgent({
      name: "deps-step-worker",
      isLead: false,
      status: "idle",
    });
    const dependency = await createTaskExtended("upstream fix", { source: "mcp" });

    const { response, task } = await dispatchStepFor("after-fix", stepAgent.id, {
      dependsOn: [dependency.id],
    });

    expect(task.dependsOn).toEqual([dependency.id]);
    expect(await getPendingTaskForAgent(stepAgent.id)).toBeNull();

    await completeTask(dependency.id, "fixed");
    expect((await getPendingTaskForAgent(stepAgent.id))?.id).toBe(task.id);

    await completeTask(task.id, "done");
    expect((await response).status).toBe(200);
  });

  test("agent-task dispatch without dependsOn is startable at once", async () => {
    const stepAgent = await createAgent({
      name: "no-deps-step-worker",
      isLead: false,
      status: "idle",
    });

    const { response, task } = await dispatchStepFor("no-deps", stepAgent.id);

    expect(task.dependsOn).toEqual([]);
    expect((await getPendingTaskForAgent(stepAgent.id))?.id).toBe(task.id);

    await completeTask(task.id, "done");
    expect((await response).status).toBe(200);
  });

  test("agent-task dispatch rejects a dependsOn entry that is not a task UUID", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id: runId } = (await created.json()) as { id: string };

    const response = await dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ stepKey: "bad-deps", task: "x", dependsOn: ["not-a-uuid"] }),
    });

    expect(response.status).toBe(400);
    expect(await getLatestScriptRunStepTaskByContextKey(`script-run:${runId}:bad-deps`)).toBeNull();
  });

  test("agent-task polling returns the step output when a newer completed follow-up shares its context key", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id: runId } = (await created.json()) as { id: string };

    const callPromise = dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ stepKey: "plan", task: "write the plan" }),
    });

    await Bun.sleep(50);
    const contextKey = `script-run:${runId}:plan`;
    const step = await getLatestScriptRunStepTaskByContextKey(contextKey);
    expect(step).not.toBeNull();
    const stepOutput = JSON.stringify({ plan: ["inspect", "implement", "verify"] });
    await completeTask((step as { id: string }).id, stepOutput);

    await Bun.sleep(2);
    const followUp = await createTaskExtended("review the plan", {
      taskType: "follow-up",
      source: "system",
      parentTaskId: step?.id,
    });
    await completeTask(followUp.id, "Reviewed the plan; proceed.");
    expect((await getLatestTaskByContextKey(contextKey))?.id).toBe(followUp.id);

    const response = await callPromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: step?.id, taskOutput: stepOutput });
  });

  test("a failed follow-up sharing the context key does not fail a completed agent-task step", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id: runId } = (await created.json()) as { id: string };

    const callPromise = dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ stepKey: "review", task: "review the plan" }),
    });

    await Bun.sleep(50);
    const contextKey = `script-run:${runId}:review`;
    const step = await getLatestScriptRunStepTaskByContextKey(contextKey);
    expect(step).not.toBeNull();
    const stepOutput = JSON.stringify({ approved: true });
    await completeTask((step as { id: string }).id, stepOutput);

    await Bun.sleep(2);
    const followUp = await createTaskExtended("review the review", {
      taskType: "follow-up",
      source: "system",
      parentTaskId: step?.id,
    });
    await failTask(followUp.id, "Lead follow-up failed");
    expect((await getLatestTaskByContextKey(contextKey))?.id).toBe(followUp.id);

    const response = await callPromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: step?.id, taskOutput: stepOutput });
  });

  test("cancel leaves terminal script runs unchanged", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id } = (await created.json()) as { id: string };
    await updateScriptRun(id, {
      status: "failed",
      pid: null,
      finishedAt: new Date().toISOString(),
      error: "original failure",
    });

    const cancelled = await dispatch(`/api/script-runs/${id}`, {
      method: "DELETE",
      agentId,
    });
    expect(cancelled.status).toBe(204);

    const detail = await dispatch(`/api/script-runs/${id}`, { agentId });
    const body = (await detail.json()) as { run: { status: string; error?: string } };
    expect(body.run.status).toBe("failed");
    expect(body.run.error).toBe("original failure");
  });
});

describe("durable launch source with an embedded secret", () => {
  test("is refused before the run row is written", async () => {
    const value = `durable-${randomToken(32)}`;
    const name = configSecretName("DURABLE_TOKEN");
    registerStoredSecret(value, name);
    try {
      const before = await getDbClient().get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM script_runs",
      );
      const response = await dispatch("/api/script-runs", {
        method: "POST",
        agentId,
        body: createBody({
          source: `export default async function main() { return { auth: "${value}" }; }`,
        }),
      });
      expect(response.status).toBe(400);
      expect(response.text).not.toContain(value);
      const body = (await response.json()) as { error: string; findings: { id: string }[] };
      expect(body.error).toBe("source_contains_secret");
      expect(body.findings.map((f) => f.id)).toEqual([name]);
      const after = await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM script_runs");
      expect(after?.n).toBe(before?.n);
    } finally {
      clearVolatileSecretsForTesting();
    }
  });
});

describe("POST /api/internal/raw-llm failure", () => {
  const KEY_VARS = ["NAN_API_KEY", "HELMCODE_API_NAN"] as const;

  // The provider echoes the key it received; `selectCredential` sends it
  // trimmed, so a padded config value must still be redacted.
  async function withNanKey(
    keyVar: (typeof KEY_VARS)[number],
    pad: string,
    fn: (dummy: string, calls: () => number) => Promise<void>,
    dummy = `nan-${randomToken(32)}`,
  ) {
    const previous = Object.fromEntries(KEY_VARS.map((name) => [name, process.env[name]]));
    const previousFetch = globalThis.fetch;
    for (const name of KEY_VARS) delete process.env[name];
    process.env[keyVar] = `${pad}${dummy}${pad}`;
    refreshSecretScrubberCache();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: `Invalid API key: ${dummy}`, type: "auth" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      await fn(dummy, () => calls);
    } finally {
      globalThis.fetch = previousFetch;
      for (const name of KEY_VARS) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      refreshSecretScrubberCache();
    }
  }

  for (const keyVar of KEY_VARS) {
    for (const pad of ["", "  "]) {
      const label = pad ? "padded" : "unpadded";
      test(`does not echo a provider error that carries the ${label} ${keyVar} key`, async () => {
        await withNanKey(keyVar, pad, async (dummy, calls) => {
          const response = await dispatch("/api/internal/raw-llm", {
            method: "POST",
            agentId,
            body: JSON.stringify({ prompt: "hi", model: "nan/qwen3.8-flash" }),
          });
          expect(calls()).toBe(1);
          expect(response.status).toBe(500);
          expect(response.text).not.toContain(dummy);
          const body = (await response.json()) as { error: string };
          expect(body.error).toContain("LLM call failed");
          expect(body.error).toContain(`[REDACTED:${keyVar}]`);
        });
      });
    }

    // A random key can contain "529"; that must not read as an overload.
    test(`a ${keyVar} key containing 529 is not mistaken for a rate limit`, async () => {
      await withNanKey(
        keyVar,
        "",
        async (dummy, calls) => {
          const result = await executeRawLlm({ prompt: "hi", model: "nan/qwen3.8-flash" });
          expect(calls()).toBe(1);
          expect(result.status).toBe("failed");
          if (result.status === "failed") expect(result.error).not.toContain(dummy);
        },
        `nan-5L76Mxo2D529A9S0GrqOZWIpYdfO1aIM`,
      );
    });

    test(`scrubs the fallback-port error for a padded ${keyVar} key`, async () => {
      await withNanKey(keyVar, "  ", async (dummy, calls) => {
        const result = await executeRawLlm({
          prompt: "hi",
          model: "nan/qwen3.8-flash",
          fallbackPort: "fallback",
        });
        expect(calls()).toBe(1);
        expect(result.status).toBe("success");
        expect(result.error).toContain("using fallback port");
        expect(result.error).not.toContain(dummy);
        expect(result.error).toContain(`[REDACTED:${keyVar}]`);
      });
    });
  }
});
