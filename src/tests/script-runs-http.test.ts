import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  countAgentDispatchesInThread,
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
import * as modelValidation from "../be/model-validation";
import { configSecretName, registerStoredSecret } from "../be/secret-registry";
import { handleCore } from "../http/core";
import { handleScriptRuns } from "../http/script-runs";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { localProcessScriptExecutor } from "../script-workflows/executor";
import { setScriptRunExecutor } from "../script-workflows/supervisor";
import {
  FOLLOW_UP_DISPATCH_CAP,
  FOLLOW_UP_DISPATCH_WINDOW_MINUTES,
} from "../tasks/follow-up-redelegation-guard";
import { sendTaskHandler, sendTaskInputSchema } from "../tools/send-task";
import { ownerCtx } from "../tools/task-tool-ctx";
import type { AgentTask, CreateTaskOptions } from "../types";
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

describe("ctx.step.agentTask follow-up re-delegation guard", () => {
  /** A session task of the launching agent in a Slack thread (a follow-up by default). */
  async function session(channel: string, thread: string, taskType = "follow-up") {
    return createTaskExtended("Worker task completed — review needed.", {
      agentId,
      source: "system",
      taskType,
      slackChannelId: channel,
      slackThreadTs: thread,
    });
  }

  async function completedWork(channel: string, thread: string, text: string) {
    const task = await createTaskExtended(text, {
      slackChannelId: channel,
      slackThreadTs: thread,
    });
    await completeTask(task.id, "done");
    return task;
  }

  async function launch(sourceTaskId?: string): Promise<string> {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
      headers: sourceTaskId ? { "X-Source-Task-Id": sourceTaskId } : {},
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as { id: string }).id;
  }

  /**
   * Call the step route and complete the step task it creates (as a worker
   * would), so the route's long-poll returns 200. A blocked step returns at once.
   */
  async function step(
    runId: string,
    stepKey: string,
    task: string,
    extra: Record<string, unknown> = {},
  ): Promise<TestResponse> {
    let settled = false;
    const response = dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId,
      body: JSON.stringify({ stepKey, task, ...extra }),
    }).finally(() => {
      settled = true;
    });
    const contextKey = `script-run:${runId}:${stepKey}`;
    for (let i = 0; i < 100 && !settled; i++) {
      const created = await getLatestScriptRunStepTaskByContextKey(contextKey);
      if (created) {
        if (created.status !== "completed") await completeTask(created.id, "done");
        break;
      }
      await Bun.sleep(10);
    }
    return response;
  }

  /** Dispatches by the launching agent already in the thread, as send-task makes them. */
  async function sendTaskDispatches(channel: string, thread: string, count: number) {
    for (let i = 0; i < count; i++) {
      await createTaskExtended(`earlier send-task dispatch ${i} unique words ${i * 19}`, {
        creatorAgentId: agentId,
        source: "mcp",
        slackChannelId: channel,
        slackThreadTs: thread,
      });
    }
  }

  test("records the launching session's task, but not another agent's", async () => {
    const own = await session("C_RUN_SRC", "1.1");
    const runId = await launch(own.id);
    expect(
      await getDbClient().get("SELECT sourceTaskId FROM script_runs WHERE id = ?", [runId]),
    ).toEqual({ sourceTaskId: own.id });

    const other = await createAgent({ name: "guard-other-agent", isLead: false, status: "idle" });
    const foreign = await createTaskExtended("someone else's session", { agentId: other.id });
    const foreignRun = await launch(foreign.id);
    expect(
      await getDbClient().get("SELECT sourceTaskId FROM script_runs WHERE id = ?", [foreignRun]),
    ).toEqual({ sourceTaskId: null });
  });

  test("a run that repeats completed thread work is blocked unless allowRedelegation", async () => {
    const done = await completedWork(
      "C_RUN_SAME",
      "2.1",
      "rebuild the pricing deck from the new numbers",
    );
    const followUp = await session("C_RUN_SAME", "2.1");
    const runId = await launch(followUp.id);

    const blocked = await step(runId, "rebuild", "rebuild the pricing deck from the new numbers");
    expect(blocked.status).toBe(422);
    const body = (await blocked.json()) as { error: string; rule: string };
    expect(body.rule).toBe("same-work");
    expect(body.error).toContain(done.id.slice(0, 8));
    expect(body.error).toContain("allowRedelegation: true");
    expect(await getLatestScriptRunStepTaskByContextKey(`script-run:${runId}:rebuild`)).toBeNull();

    const allowed = await step(runId, "rebuild", "rebuild the pricing deck from the new numbers", {
      allowRedelegation: true,
    });
    expect(allowed.status).toBe(200);
  });

  test("later steps are never compared against the run's own completed steps", async () => {
    const followUp = await session("C_RUN_STEPS", "3.1");
    const runId = await launch(followUp.id);
    const text = "render slide variations for the seed deck review";

    const first = await step(runId, "slide-1", text, { parentTaskId: followUp.id });
    expect(first.status).toBe(200);
    const firstTask = await getLatestScriptRunStepTaskByContextKey(`script-run:${runId}:slide-1`);
    expect(firstTask?.slackThreadTs).toBe("3.1");
    expect(firstTask?.status).toBe("completed");
    expect(firstTask?.creatorAgentId).toBe(agentId);

    const second = await step(runId, "slide-2", text, { parentTaskId: followUp.id });
    expect(second.status).toBe(200);
  });

  test("a 29-step run counts once, and its later steps never hit the loop cap", async () => {
    await sendTaskDispatches("C_RUN_LONG", "4.1", FOLLOW_UP_DISPATCH_CAP - 1);
    const followUp = await session("C_RUN_LONG", "4.1");
    const runId = await launch(followUp.id);

    const first = await step(runId, "slide-1", "deck slide 1 opening words", {
      parentTaskId: followUp.id,
    });
    expect(first.status).toBe(200);
    // The thread now holds 10 dispatches; a per-step cap check would block these.
    const rest = await Promise.all(
      Array.from({ length: 28 }, (_, i) =>
        step(runId, `slide-${i + 2}`, `deck slide ${i + 2} words ${(i + 2) * 23}`, {
          parentTaskId: followUp.id,
        }),
      ),
    );
    expect(rest.map((r) => r.status)).toEqual(Array(28).fill(200));
    expect(
      await countAgentDispatchesInThread(
        "C_RUN_LONG",
        "4.1",
        agentId,
        FOLLOW_UP_DISPATCH_WINDOW_MINUTES,
      ),
    ).toBe(FOLLOW_UP_DISPATCH_CAP);
  }, 30_000);

  test("after 10 dispatches in the thread, the next run is blocked by the loop cap", async () => {
    const followUp = await session("C_RUN_CAP", "5.1");
    await sendTaskDispatches("C_RUN_CAP", "5.1", FOLLOW_UP_DISPATCH_CAP / 2);
    for (let r = 0; r < FOLLOW_UP_DISPATCH_CAP / 2; r++) {
      const earlier = await launch(followUp.id);
      // Random words, so no earlier step matches a later run's first step.
      const responses = await Promise.all(
        [0, 1].map((i) =>
          step(earlier, `s-${i}`, Array.from({ length: 4 }, () => crypto.randomUUID()).join(" "), {
            parentTaskId: followUp.id,
          }),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
    }

    const runId = await launch(followUp.id);
    const blocked = await step(runId, "next", "publish the investor update email draft");
    expect(blocked.status).toBe(422);
    const body = (await blocked.json()) as { error: string; rule: string };
    expect(body.rule).toBe("loop-cap");
    expect(body.error).toContain(`dispatched ${FOLLOW_UP_DISPATCH_CAP} times`);

    const allowed = await step(runId, "next", "publish the investor update email draft", {
      allowRedelegation: true,
    });
    expect(allowed.status).toBe(200);
  }, 30_000);

  test("a replayed stepKey is never blocked, even after the thread hit the cap", async () => {
    const followUp = await session("C_RUN_REPLAY", "6.1");
    const runId = await launch(followUp.id);
    const first = await step(runId, "only", "compile the weekly metrics digest");
    expect(first.status).toBe(200);

    await sendTaskDispatches("C_RUN_REPLAY", "6.1", FOLLOW_UP_DISPATCH_CAP);
    await completedWork("C_RUN_REPLAY", "6.1", "compile the weekly metrics digest");

    const replay = await step(runId, "only", "compile the weekly metrics digest");
    expect(replay.status).toBe(200);
  });

  test("another agent cannot dispatch steps on a run it does not own", async () => {
    const runId = await launch();
    const intruder = await createAgent({ name: "guard-intruder", isLead: false, status: "idle" });
    const response = await dispatch(`/api/internal/script-runs/${runId}/agent-task`, {
      method: "POST",
      agentId: intruder.id,
      body: JSON.stringify({ stepKey: "forged", task: "do work attributed to someone else" }),
    });
    expect(response.status).toBe(403);
    expect(await getLatestScriptRunStepTaskByContextKey(`script-run:${runId}:forged`)).toBeNull();
  });

  test("a run not launched from a follow-up is unaffected", async () => {
    await completedWork("C_RUN_PLAIN", "7.1", "refresh the onboarding checklist copy");
    await sendTaskDispatches("C_RUN_PLAIN", "7.1", FOLLOW_UP_DISPATCH_CAP);
    const feature = await session("C_RUN_PLAIN", "7.1", "feature");

    for (const sourceTaskId of [feature.id, undefined]) {
      const runId = await launch(sourceTaskId);
      const response = await step(runId, "refresh", "refresh the onboarding checklist copy");
      expect(response.status).toBe(200);
    }
  });

  async function backdate(taskId: string, minutesAgo: number): Promise<void> {
    const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    await getDbClient().run(
      "UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?",
      [at, at, taskId],
    );
  }

  async function dispatchCount(channel: string, thread: string): Promise<number> {
    return countAgentDispatchesInThread(
      channel,
      thread,
      agentId,
      FOLLOW_UP_DISPATCH_WINDOW_MINUTES,
    );
  }

  /** A send-task from the follow-up session to another worker. */
  async function sendTask(sourceTaskId: string, task: string) {
    const target = await createAgent({
      name: `guard-target-${crypto.randomUUID()}`,
      isLead: false,
      status: "idle",
      maxTasks: 100,
    });
    return sendTaskHandler(
      ownerCtx({ agentId, sourceTaskId }),
      sendTaskInputSchema.parse({
        task,
        agentId: target.id,
        routingReason: "skill",
        routingNote: "target owns this work",
      }),
    );
  }

  const randomText = () => Array.from({ length: 4 }, () => crypto.randomUUID()).join(" ");

  test("a step with no parent is attributed to the follow-up's thread", async () => {
    const followUp = await session("C_RUN_NOPARENT", "8.1");
    const first = await launch(followUp.id);
    const text = "draft the quarterly churn analysis for finance";
    expect((await step(first, "churn", text)).status).toBe(200);
    const stepTask = await getLatestScriptRunStepTaskByContextKey(`script-run:${first}:churn`);
    expect(stepTask?.slackChannelId).toBe("C_RUN_NOPARENT");
    expect(stepTask?.slackThreadTs).toBe("8.1");
    expect(await dispatchCount("C_RUN_NOPARENT", "8.1")).toBe(1);

    // Another run repeating the completed step is the same work.
    const second = await launch(followUp.id);
    const repeat = await step(second, "churn-again", text);
    expect(repeat.status).toBe(422);
    expect(((await repeat.json()) as { rule: string }).rule).toBe("same-work");
  });

  test("a step whose parent sits in another thread is attributed to the follow-up's thread", async () => {
    const followUp = await session("C_RUN_XPARENT", "9.1");
    const foreignParent = await createTaskExtended("earlier work in another thread", {
      agentId,
      slackChannelId: "C_RUN_XPARENT_OTHER",
      slackThreadTs: "9.9",
    });
    const first = await launch(followUp.id);
    const text = "audit the vendor contracts for renewal dates";
    expect((await step(first, "audit", text, { parentTaskId: foreignParent.id })).status).toBe(200);
    const stepTask = await getLatestScriptRunStepTaskByContextKey(`script-run:${first}:audit`);
    expect(stepTask?.parentTaskId).toBe(foreignParent.id);
    expect(stepTask?.slackChannelId).toBe("C_RUN_XPARENT");
    expect(stepTask?.slackThreadTs).toBe("9.1");
    expect(await dispatchCount("C_RUN_XPARENT", "9.1")).toBe(1);
    expect(await dispatchCount("C_RUN_XPARENT_OTHER", "9.9")).toBe(0);

    const second = await launch(followUp.id);
    const repeat = await step(second, "audit-again", text, { parentTaskId: foreignParent.id });
    expect(repeat.status).toBe(422);
    expect(((await repeat.json()) as { rule: string }).rule).toBe("same-work");
  });

  /**
   * Hold the next matching task insert for 300 ms. `started` resolves when it
   * begins, so a test can start a competing dispatch while the first one sits
   * between its guard decision and its insert.
   */
  function stallNextInsert(matches: (options: CreateTaskOptions | undefined) => boolean) {
    const original = db.createTaskExtended;
    let reached: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let armed = true;
    const spy = spyOn(db, "createTaskExtended").mockImplementation(async (task, options) => {
      if (armed && matches(options)) {
        armed = false;
        reached();
        await Bun.sleep(300);
      }
      return original(task, options);
    });
    return { started, restore: () => spy.mockRestore() };
  }

  const isStep = (options: CreateTaskOptions | undefined) =>
    options?.taskType === "script-run-step";

  test("a step racing a blocked sibling of its run: the run dispatches all or none", async () => {
    const matching = "rebuild the hiring pipeline dashboard from scratch";
    await completedWork("C_RUN_PAR", "10.1", matching);
    const followUp = await session("C_RUN_PAR", "10.1");
    const runId = await launch(followUp.id);

    // The distinct step decides first and is mid-insert when the matching one arrives.
    const stall = stallNextInsert(isStep);
    try {
      const distinct = step(runId, "distinct", randomText());
      await stall.started;
      const repeat = step(runId, "repeat", matching);
      expect([(await distinct).status, (await repeat).status]).toEqual([200, 200]);
    } finally {
      stall.restore();
    }
  }, 30_000);

  test("a stepKey racing its own first dispatch replays the same task", async () => {
    const followUp = await session("C_RUN_SAMEKEY", "15.1");
    const runId = await launch(followUp.id);
    const text = randomText();

    // Both calls miss the replay lookup; the first then waits before its insert.
    const original = modelValidation.explicitModelErrorForAgent;
    let reached: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let calls = 0;
    const spy = spyOn(modelValidation, "explicitModelErrorForAgent").mockImplementation(
      async (input) => {
        if (calls++ === 0) {
          reached();
          await Bun.sleep(300);
        }
        return original(input);
      },
    );
    let responses: TestResponse[];
    try {
      const first = step(runId, "once", text);
      await started;
      const second = step(runId, "once", text);
      responses = [await first, await second];
    } finally {
      spy.mockRestore();
    }
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const ids = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { taskId: string }).taskId),
    );
    expect(ids[0]).toBe(ids[1]);
    const rows = await getDbClient().get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM agent_tasks WHERE contextKey = ?",
      [`script-run:${runId}:once`],
    );
    expect(rows?.c).toBe(1);
  }, 30_000);

  test("a blocked first step blocks the run's later steps until one overrides", async () => {
    const matching = "migrate the billing webhooks to the new endpoint";
    await completedWork("C_RUN_STICKY", "11.1", matching);
    const followUp = await session("C_RUN_STICKY", "11.1");
    const runId = await launch(followUp.id);

    expect((await step(runId, "repeat", matching)).status).toBe(422);
    const later = await step(runId, "distinct", randomText());
    expect(later.status).toBe(422);
    expect(((await later.json()) as { rule: string }).rule).toBe("same-work");

    const overridden = await step(runId, "repeat", matching, { allowRedelegation: true });
    expect(overridden.status).toBe(200);
    expect((await step(runId, "after-override", randomText())).status).toBe(200);
  });

  test("two runs racing at the cap minus one: exactly one dispatches", async () => {
    await sendTaskDispatches("C_RUN_RACE", "12.1", FOLLOW_UP_DISPATCH_CAP - 1);
    const followUp = await session("C_RUN_RACE", "12.1");
    const [a, b] = [await launch(followUp.id), await launch(followUp.id)];

    const stall = stallNextInsert(isStep);
    try {
      const first = step(a, "go", randomText());
      await stall.started;
      const second = step(b, "go", randomText());
      expect([(await first).status, (await second).status]).toEqual([200, 422]);
    } finally {
      stall.restore();
    }
    expect(await dispatchCount("C_RUN_RACE", "12.1")).toBe(FOLLOW_UP_DISPATCH_CAP);
  }, 30_000);

  test("a run and a send-task racing at the cap minus one: exactly one dispatches, in either order", async () => {
    for (const [i, runFirst] of [true, false].entries()) {
      const thread = `13.${i}`;
      await sendTaskDispatches("C_RUN_MIX_RACE", thread, FOLLOW_UP_DISPATCH_CAP - 1);
      const followUp = await session("C_RUN_MIX_RACE", thread);
      const runId = await launch(followUp.id);
      const runCall = async () => (await step(runId, "go", randomText())).status === 200;
      const sendCall = async () => (await sendTask(followUp.id, randomText())).ok;

      // Whichever dispatcher goes first is mid-insert when the other arrives.
      const stall = stallNextInsert((options) => isStep(options) === runFirst);
      try {
        const first = runFirst ? runCall() : sendCall();
        await stall.started;
        const second = runFirst ? sendCall() : runCall();
        expect([await first, await second]).toEqual([true, false]);
      } finally {
        stall.restore();
      }
      expect(await dispatchCount("C_RUN_MIX_RACE", thread)).toBe(FOLLOW_UP_DISPATCH_CAP);
    }
  }, 30_000);

  test("a long run is dated by its first step, not by steps it adds later", async () => {
    await sendTaskDispatches("C_RUN_WINDOW", "14.1", FOLLOW_UP_DISPATCH_CAP - 1);
    const followUp = await session("C_RUN_WINDOW", "14.1");
    const longRun = await launch(followUp.id);
    expect((await step(longRun, "first", randomText())).status).toBe(200);
    const firstStep = await getLatestScriptRunStepTaskByContextKey(`script-run:${longRun}:first`);
    await backdate(firstStep!.id, FOLLOW_UP_DISPATCH_WINDOW_MINUTES + 60);
    expect(await dispatchCount("C_RUN_WINDOW", "14.1")).toBe(FOLLOW_UP_DISPATCH_CAP - 1);

    // A step created now does not move the run into the window.
    expect((await step(longRun, "later", randomText())).status).toBe(200);
    expect(await dispatchCount("C_RUN_WINDOW", "14.1")).toBe(FOLLOW_UP_DISPATCH_CAP - 1);

    // A run whose first step is inside the window counts once.
    const freshRun = await launch(followUp.id);
    expect((await step(freshRun, "first", randomText())).status).toBe(200);
    expect((await step(freshRun, "second", randomText())).status).toBe(200);
    expect(await dispatchCount("C_RUN_WINDOW", "14.1")).toBe(FOLLOW_UP_DISPATCH_CAP);
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
