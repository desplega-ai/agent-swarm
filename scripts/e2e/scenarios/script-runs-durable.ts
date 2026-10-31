import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callToolErr,
  callToolOk,
  registerAgent,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";

const TERMINAL = ["completed", "failed", "cancelled", "aborted_limit"];
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

async function waitForTerminalRun(
  ctx: ScenarioContext,
  runId: string,
): Promise<{ run: Record<string, unknown>; journal: Record<string, unknown>[] }> {
  let last: Record<string, unknown> = {};
  const ok = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/script-runs/${runId}`);
    expectStatus(response, [200], "poll script run");
    last = asRecord(response.json);
    return TERMINAL.includes(String(asRecord(last.run).status));
  }, 60_000);
  expect(
    ok,
    `script run ${runId} never reached a terminal status: ${JSON.stringify(last).slice(0, 400)}`,
  );
  return { run: asRecord(last.run), journal: asRecords(last, "journal") };
}

async function createRun(
  ctx: ScenarioContext,
  agentId: string,
  body: Record<string, unknown>,
  label: string,
): Promise<string> {
  const created = await ctx.api("POST", "/api/script-runs", { agentId, body });
  expectStatus(created, [201], label);
  return asString(asRecord(created.json).id, `${label} id`);
}

const NOOP = "export default async function () { return 1; }";

/**
 * Flow `script-runs-durable`: a background durable run that journals raw-llm, swarm-script and
 * agent-task steps (so the per-run /api/internal/script-runs/* routes and /api/internal/raw-llm
 * run for real, with a simulated worker finishing the delegated task), then every run route and
 * every internal route driven directly, then the launch/get/list MCP tools.
 */
export const scriptRunsDurable: Scenario = {
  name: "script-runs-durable",
  order: 440,
  async run(ctx) {
    const launcherId = await registerAgent(ctx, "durable");
    const outsiderId = await registerAgent(ctx, "durable-outsider");
    const worker = await ctx.startAgent({
      name: `e2e-script-durable-worker-${ctx.nonce}`,
      onTask: ({ task }) =>
        String(task.task).includes("please fail")
          ? { status: "failed", output: "worker refused" }
          : { status: "completed", output: `worker-did:${String(task.task)}` },
    });
    const who = `bob-${ctx.nonce}`;
    const runName = `e2e-durable-${ctx.nonce}`;

    // ── A. a real background run: three step kinds, journaled, replayable ──
    const source = `export default async function (args: { who: string; workerId: string }, ctx: any) {
  const llm = await ctx.step.rawLlm("ask", { prompt: "say hi to " + args.who });
  const structured = await ctx.step.rawLlm("ask-structured", {
    prompt: "classify " + args.who,
    schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  });
  const sub = await ctx.step.swarmScript("sub", {
    source: "export default async function (a: any) { return { echoed: a.v }; }",
    args: { v: args.who },
  });
  const done = await ctx.step.agentTask("delegate", { task: "durable task for " + args.who, agentId: args.workerId });
  const failed = await ctx.step.agentTask("delegate-fail", {
    task: "please fail for " + args.who,
    agentId: args.workerId,
    failOnTaskFailure: false,
  });
  return { llm, structured, sub, done, failed, runId: ctx.run.id, runAgent: ctx.run.agentId };
}`;
    const idempotencyKey = `e2e-durable-idem-${ctx.nonce}`;
    const created = await ctx.api("POST", "/api/script-runs", {
      agentId: launcherId,
      body: {
        source,
        args: { who, workerId: worker.agentId },
        scriptName: runName,
        idempotencyKey,
      },
    });
    expectStatus(created, [201], "launch the durable run");
    const createdBody = asRecord(created.json);
    const runId = asString(createdBody.id, "run id");
    expect(createdBody.status === "running", "a background run starts as running");
    expect(
      String(createdBody.url).endsWith(`/script-runs/${runId}`),
      `the run URL must point at the dashboard page: ${String(createdBody.url)}`,
    );

    const duplicate = await ctx.api("POST", "/api/script-runs", {
      agentId: launcherId,
      body: { source: NOOP, idempotencyKey },
    });
    expectStatus(duplicate, [409], "launch with a used idempotency key");
    expect(asRecord(duplicate.json).id === runId, "the 409 must return the existing run");

    const finished = await waitForTerminalRun(ctx, runId);
    expect(
      finished.run.status === "completed" && finished.run.error === undefined,
      `durable run did not complete: ${JSON.stringify(finished.run).slice(0, 600)}`,
    );
    expect(
      finished.run.agentId === launcherId &&
        finished.run.scriptName === runName &&
        finished.run.kind === "workflow" &&
        typeof finished.run.finishedAt === "string" &&
        typeof finished.run.lastHeartbeatAt === "string",
      "the run row lost its identity, kind, finish time or heartbeat",
    );
    expect(
      /T.*Z$/.test(String(finished.run.startedAt)) && /T.*Z$/.test(String(finished.run.finishedAt)),
      `startedAt and finishedAt must both be ISO 8601: ${String(finished.run.startedAt)} / ${String(finished.run.finishedAt)}`,
    );
    const output = asRecord(finished.run.output);
    expect(output.runId === runId && output.runAgent === launcherId, "ctx.run is wrong");
    const llm = asRecord(output.llm);
    expect(
      String(llm.result).includes(`say hi to ${who}`) && typeof llm.model === "string",
      `ctx.step.rawLlm result is wrong: ${JSON.stringify(llm)}`,
    );
    expect(
      typeof asRecord(output.structured).result === "object" &&
        typeof asRecord(asRecord(output.structured).result).label === "string",
      "rawLlm with a schema must return a conforming object",
    );
    expect(
      asRecord(asRecord(output.sub).result).echoed === who,
      "ctx.step.swarmScript did not run the inline script",
    );
    expect(
      output.done === `worker-did:durable task for ${who}`,
      `ctx.step.agentTask must resolve to the task output: ${JSON.stringify(output.done)}`,
    );
    const failedStep = asRecord(output.failed);
    expect(
      failedStep.status === "failed" && typeof failedStep.taskId === "string",
      `failOnTaskFailure:false must resolve to a failure record: ${JSON.stringify(failedStep)}`,
    );

    // the journal: one entry per step, in order, with the step type and result
    expect(
      finished.journal.map((entry) => entry.stepKey).join(",") ===
        "ask,ask-structured,sub,delegate,delegate-fail",
      `journal keys are wrong: ${finished.journal.map((entry) => entry.stepKey).join(",")}`,
    );
    expect(
      finished.journal.every((entry) => entry.status === "completed" && entry.runId === runId),
      "every journal entry of this run must be completed",
    );
    const stepTypes = finished.journal.map((entry) => entry.stepType);
    expect(
      stepTypes[0] === "raw-llm" && stepTypes[3] === "agent-task" && stepTypes[4] === "agent-task",
      `journal step types are wrong: ${stepTypes.join(",")}`,
    );
    const journalRows = ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM script_run_journal WHERE runId = ?",
      [runId],
    );
    expect(journalRows?.n === 5, "script_run_journal must hold the five steps");
    expect(
      ctx.llm.requests.some((request) => JSON.stringify(request.body).includes(`say hi to ${who}`)),
      "the prompt never reached the mock inference host through /api/internal/raw-llm",
    );
    const stepTask = ctx.db.get<{
      agentId: string;
      creatorAgentId: string;
      status: string;
      output: string;
      taskType: string;
    }>(
      "SELECT agentId, creatorAgentId, status, output, taskType FROM agent_tasks WHERE contextKey = ? AND taskType = 'script-run-step'",
      [`script-run:${runId}:delegate`],
    );
    expect(
      stepTask?.taskType === "script-run-step" &&
        stepTask.agentId === worker.agentId &&
        stepTask.creatorAgentId === launcherId &&
        stepTask.status === "completed" &&
        stepTask.output === `worker-did:durable task for ${who}`,
      `the delegated step task is wrong: ${JSON.stringify(stepTask)}`,
    );
    const failedTask = ctx.db.get<{ status: string; output: string }>(
      "SELECT status, output FROM agent_tasks WHERE contextKey = ? AND taskType = 'script-run-step'",
      [`script-run:${runId}:delegate-fail`],
    );
    expect(failedTask?.status === "failed", "the refused step task must be failed");

    // ── list with filters, pagination and validation ──
    const filtered = await ctx.api(
      "GET",
      `/api/script-runs?scriptName=${encodeURIComponent(runName)}&status=completed&agentId=${launcherId}&limit=5&offset=0`,
    );
    expectStatus(filtered, [200], "list runs with filters");
    const filteredBody = asRecord(filtered.json);
    const listedRuns = asRecords(filteredBody, "runs");
    expect(
      filteredBody.total === 1 && listedRuns.length === 1 && listedRuns[0]?.id === runId,
      `filters must narrow to the run: ${filtered.text.slice(0, 300)}`,
    );
    expect(listedRuns[0]?.source === undefined, "the list projection must not carry the source");
    const otherAgent = await ctx.api(
      "GET",
      `/api/script-runs?scriptName=${runName}&agentId=${outsiderId}`,
    );
    expect(asRecord(otherAgent.json).total === 0, "another agent has no runs of this name");
    const paged = await ctx.api("GET", "/api/script-runs?limit=1&offset=0");
    expectStatus(paged, [200], "list runs paged");
    expect(asRecords(paged.json, "runs").length === 1, "limit=1 must return one run");
    expectStatus(await ctx.api("GET", "/api/script-runs?status=bogus"), [400], "list bad status");
    expectStatus(await ctx.api("GET", "/api/script-runs?limit=501"), [400], "list limit above 500");
    expectStatus(await ctx.api("GET", `/api/script-runs/${UNKNOWN_ID}`), [404], "get unknown run");
    expectStatus(await ctx.api("GET", "/api/script-runs/not-a-uuid"), [400], "get run bad id");

    // ── launch validation ──
    expectStatus(
      await ctx.api("POST", "/api/script-runs", { body: { source: NOOP } }),
      [400],
      "launch without X-Agent-ID",
    );
    expectStatus(
      await ctx.api("POST", "/api/script-runs", {
        agentId: `no-such-agent-${ctx.nonce}`,
        body: { source: NOOP },
      }),
      [404],
      "launch as an unknown agent",
    );
    expectStatus(
      await ctx.api("POST", "/api/script-runs", { agentId: launcherId, body: {} }),
      [400],
      "launch without source",
    );
    const loopLabels = await ctx.api("POST", "/api/script-runs", {
      agentId: launcherId,
      body: {
        source: `export default async function (args: unknown, ctx: any) {
  for (const item of [1, 2]) { await ctx.step.rawLlm("same-label", { prompt: String(item) }); }
}`,
      },
    });
    expectStatus(loopLabels, [400], "launch with a loop label collision");
    expect(asRecord(loopLabels.json).error === "label_lint_violation", "label lint error code");
    expect(
      asRecords(loopLabels.json, "violations").some((entry) => entry.label === "same-label"),
      "label lint must name the colliding label",
    );
    const token = ["ghp", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"].join("_");
    const secretLaunch = await ctx.api("POST", "/api/script-runs", {
      agentId: launcherId,
      body: { source: `export default async function () { return "${token}"; }` },
    });
    expectStatus(secretLaunch, [400], "launch with a secret in the source");
    expect(asRecord(secretLaunch.json).error === "source_contains_secret", "secret refusal");

    // ── B. internal journal routes, driven directly on a run that no harness owns ──
    const manualId = await createRun(
      ctx,
      launcherId,
      { source: NOOP, background: false, scriptName: `e2e-manual-${ctx.nonce}` },
      "launch a manual run",
    );
    const internal = `/api/internal/script-runs/${manualId}`;
    expectStatus(await ctx.api("GET", `${internal}/steps/s1`), [404], "missing journal step");
    const stepBody = {
      stepKey: "s1",
      stepType: "raw-llm",
      config: { prompt: "p" },
      status: "completed",
      result: { value: 1 },
      durationMs: 5,
    };
    const wrote = await ctx.api("POST", `${internal}/steps`, {
      agentId: launcherId,
      body: stepBody,
    });
    expectStatus(wrote, [201], "write a journal step");
    expect(JSON.stringify(wrote.json) === JSON.stringify({ ok: true }), "step write response");
    const read = await ctx.api("GET", `${internal}/steps/s1`);
    expectStatus(read, [200], "read a journal step");
    expect(
      JSON.stringify(read.json) ===
        JSON.stringify({
          stepKey: "s1",
          stepType: "raw-llm",
          status: "completed",
          result: { value: 1 },
        }),
      `journal replay shape is wrong: ${read.text}`,
    );
    // The journal is write-once per step key: a replayed write is acknowledged with 201 but the
    // first result stays, so a resumed run replays exactly what it recorded the first time.
    const rewrite = await ctx.api("POST", `${internal}/steps`, {
      body: { ...stepBody, result: { value: 2 } },
    });
    expectStatus(rewrite, [201], "rewrite a journal step");
    const replayed = await ctx.api("GET", `${internal}/steps/s1`);
    expect(
      JSON.stringify(asRecord(replayed.json).result) === JSON.stringify({ value: 1 }),
      "the first journal write for a step key must win",
    );
    const key = ["sk", "ant", "api03", "A".repeat(40)].join("-");
    const failedWrite = await ctx.api("POST", `${internal}/steps`, {
      body: { stepKey: "s2", stepType: "agent-task", status: "failed", error: `nope ${key}` },
    });
    expectStatus(failedWrite, [201], "write a failed journal step");
    const failedRead = asRecord((await ctx.api("GET", `${internal}/steps/s2`)).json);
    expect(
      failedRead.status === "failed" &&
        String(failedRead.error).startsWith("nope ") &&
        !String(failedRead.error).includes(key),
      `a failed step must replay as failed with the secret scrubbed: ${JSON.stringify(failedRead)}`,
    );
    expectStatus(
      await ctx.api("POST", `${internal}/steps`, {
        body: { stepKey: "s3", stepType: "x", status: "pending" },
      }),
      [400],
      "journal step with an invalid status",
    );
    expectStatus(
      await ctx.api("POST", `/api/internal/script-runs/${UNKNOWN_ID}/steps`, { body: stepBody }),
      [404],
      "journal step for an unknown run",
    );
    expectStatus(
      await ctx.api("GET", `/api/internal/script-runs/${UNKNOWN_ID}/steps/s1`),
      [404],
      "read a step of an unknown run",
    );

    // heartbeat
    expectStatus(
      await ctx.api("POST", `${internal}/heartbeat`, { agentId: launcherId }),
      [204],
      "heartbeat",
    );
    const afterBeat = asRecord(
      asRecord((await ctx.api("GET", `/api/script-runs/${manualId}`)).json).run,
    );
    expect(typeof afterBeat.lastHeartbeatAt === "string", "heartbeat must stamp lastHeartbeatAt");
    expectStatus(
      await ctx.api("POST", `/api/internal/script-runs/${UNKNOWN_ID}/heartbeat`),
      [404],
      "heartbeat for an unknown run",
    );

    // status: pause is resumable, a paused run ignores a late completion, cancel ends it
    expectStatus(
      await ctx.api("POST", `${internal}/status`, { body: { status: "paused" } }),
      [204],
      "pause",
    );
    expect(
      asRecord(asRecord((await ctx.api("GET", `/api/script-runs/${manualId}`)).json).run).status ===
        "paused",
      "the run must be paused",
    );
    expectStatus(
      await ctx.api("POST", `${internal}/status`, { body: { status: "completed", output: 1 } }),
      [204],
      "late completion of a paused run",
    );
    expect(
      asRecord(asRecord((await ctx.api("GET", `/api/script-runs/${manualId}`)).json).run).status ===
        "paused",
      "a status post for a run that is not running must be a no-op",
    );
    expectStatus(
      await ctx.api("POST", `${internal}/status`, { body: { status: "exploded" } }),
      [400],
      "invalid status",
    );
    expectStatus(
      await ctx.api("POST", `/api/internal/script-runs/${UNKNOWN_ID}/status`, {
        body: { status: "paused" },
      }),
      [404],
      "status for an unknown run",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/script-runs/${manualId}`),
      [204],
      "cancel a paused run",
    );
    const cancelled = asRecord(
      asRecord((await ctx.api("GET", `/api/script-runs/${manualId}`)).json).run,
    );
    expect(
      cancelled.status === "cancelled" && typeof cancelled.finishedAt === "string",
      "DELETE must cancel a non-terminal run",
    );
    expectStatus(await ctx.api("DELETE", `/api/script-runs/${manualId}`), [204], "cancel again");
    expectStatus(
      await ctx.api("DELETE", `/api/script-runs/${UNKNOWN_ID}`),
      [404],
      "cancel unknown",
    );

    const completeId = await createRun(
      ctx,
      launcherId,
      { source: NOOP, background: false },
      "run to complete",
    );
    expectStatus(
      await ctx.api("POST", `/api/internal/script-runs/${completeId}/status`, {
        body: { status: "completed", output: { done: ctx.nonce } },
      }),
      [204],
      "complete a running run",
    );
    const completed = asRecord(
      asRecord((await ctx.api("GET", `/api/script-runs/${completeId}`)).json).run,
    );
    expect(
      completed.status === "completed" && asRecord(completed.output).done === ctx.nonce,
      "completion must store the output",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/script-runs/${completeId}`),
      [204],
      "delete a completed run",
    );
    expect(
      asRecord(asRecord((await ctx.api("GET", `/api/script-runs/${completeId}`)).json).run)
        .status === "completed",
      "cancelling a terminal run must not rewrite its status",
    );
    const failId = await createRun(
      ctx,
      launcherId,
      { source: NOOP, background: false },
      "run to fail",
    );
    await ctx.api("POST", `/api/internal/script-runs/${failId}/status`, {
      body: { status: "failed", error: `broke ${ctx.nonce}` },
    });
    const failedRun = asRecord(
      asRecord((await ctx.api("GET", `/api/script-runs/${failId}`)).json).run,
    );
    expect(
      failedRun.status === "failed" && failedRun.error === `broke ${ctx.nonce}`,
      "a failed status must store the error",
    );

    // ── internal agent-task: ownership, parent authorization, replay, success, failure ──
    const taskRunId = await createRun(
      ctx,
      launcherId,
      { source: NOOP, background: false },
      "agent-task run",
    );
    const agentTask = `/api/internal/script-runs/${taskRunId}/agent-task`;
    expectStatus(
      await ctx.api("POST", agentTask, { agentId: outsiderId, body: { stepKey: "t", task: "x" } }),
      [403],
      "agent-task from another agent",
    );
    expectStatus(
      await ctx.api("POST", agentTask, { body: { stepKey: "t", task: "x" } }),
      [403],
      "agent-task without an agent",
    );
    expectStatus(
      await ctx.api("POST", `/api/internal/script-runs/${UNKNOWN_ID}/agent-task`, {
        agentId: launcherId,
        body: { stepKey: "t", task: "x" },
      }),
      [404],
      "agent-task for an unknown run",
    );
    expectStatus(
      await ctx.api("POST", agentTask, { agentId: launcherId, body: { task: "x" } }),
      [400],
      "agent-task without a stepKey",
    );
    const foreignTask = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `foreign parent ${ctx.nonce}`,
        agentId: outsiderId,
        source: "api",
        routingReason: "human_pinned",
      },
    });
    expectStatus(foreignTask, [201], "create a task the run's agent has no context for");
    const refused = await ctx.api("POST", agentTask, {
      agentId: launcherId,
      body: {
        stepKey: "child",
        task: "x",
        parentTaskId: asString(asRecord(foreignTask.json).id, "id"),
      },
    });
    expectStatus(refused, [403], "agent-task under a parent the agent has no context for");
    expect(
      String(asRecord(refused.json).error).includes("You don't have context for parent task"),
      "the parent refusal must explain itself",
    );
    const delegated = await ctx.api("POST", agentTask, {
      agentId: launcherId,
      body: { stepKey: "ok-step", task: `direct step ${ctx.nonce}`, agentId: worker.agentId },
    });
    expectStatus(delegated, [200], "agent-task completed by the simulated worker");
    const delegatedBody = asRecord(delegated.json);
    expect(
      delegatedBody.taskOutput === `worker-did:direct step ${ctx.nonce}`,
      `agent-task output is wrong: ${delegated.text}`,
    );
    const replay = await ctx.api("POST", agentTask, {
      agentId: launcherId,
      body: { stepKey: "ok-step", task: `direct step ${ctx.nonce}`, agentId: worker.agentId },
    });
    expectStatus(replay, [200], "agent-task replay");
    expect(asRecord(replay.json).taskId === delegatedBody.taskId, "a replay must reuse the task");
    const stepTaskCount = ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM agent_tasks WHERE contextKey = ? AND taskType = 'script-run-step'",
      [`script-run:${taskRunId}:ok-step`],
    );
    expect(stepTaskCount?.n === 1, "a replayed step must not dispatch a duplicate task");
    const rejected = await ctx.api("POST", agentTask, {
      agentId: launcherId,
      body: { stepKey: "bad-step", task: `please fail ${ctx.nonce}`, agentId: worker.agentId },
    });
    expectStatus(rejected, [409], "agent-task whose task failed");
    const rejectedBody = asRecord(rejected.json);
    expect(
      rejectedBody.error === "Agent task failed" && typeof rejectedBody.taskId === "string",
      `agent-task 409 body is wrong: ${rejected.text}`,
    );
    // The 202 branch (task still running) holds the request for the server's 30s long poll, so
    // it is not exercised here; the durable run above covers the wait-until-done path.

    // ── /api/internal/raw-llm called directly ──
    const marker = `raw-${ctx.nonce}`;
    const raw = await ctx.api("POST", "/api/internal/raw-llm", {
      body: { prompt: `hello ${marker}` },
    });
    expectStatus(raw, [200], "raw-llm");
    const rawBody = asRecord(raw.json);
    expect(
      String(rawBody.result).includes(`hello ${marker}`) && typeof rawBody.model === "string",
      `raw-llm response is wrong: ${raw.text}`,
    );
    const rawStructured = await ctx.api("POST", "/api/internal/raw-llm", {
      body: {
        prompt: `classify ${marker}`,
        schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
      },
    });
    expectStatus(rawStructured, [200], "raw-llm with a schema");
    expect(
      typeof asRecord(asRecord(rawStructured.json).result).label === "string",
      "raw-llm with a schema must return an object that matches it",
    );
    expectStatus(
      await ctx.api("POST", "/api/internal/raw-llm", { body: {} }),
      [400],
      "raw-llm no prompt",
    );

    // ── the concurrency cap: runs beyond it are refused with 429, and cancelling frees slots ──
    const parked: string[] = [];
    let capped: Record<string, unknown> | undefined;
    try {
      for (let attempt = 0; attempt < 14 && !capped; attempt += 1) {
        const response = await ctx.api("POST", "/api/script-runs", {
          agentId: launcherId,
          body: { source: NOOP, background: false, scriptName: `e2e-cap-${ctx.nonce}-${attempt}` },
        });
        if (response.status === 429) capped = asRecord(response.json);
        else {
          expectStatus(response, [201], "launch a parked run");
          parked.push(asString(asRecord(response.json).id, "parked run id"));
        }
      }
      expect(capped, "the concurrency cap never refused a launch");
      expect(
        capped.error === "script_run_concurrency_cap" && capped.cap === 10,
        `429 body is wrong: ${JSON.stringify(capped)}`,
      );
    } finally {
      for (const id of parked) await ctx.api("DELETE", `/api/script-runs/${id}`);
    }
    const afterCap = await ctx.api("POST", "/api/script-runs", {
      agentId: launcherId,
      body: { source: NOOP, background: false },
    });
    expectStatus(afterCap, [201], "launch after cancelling the parked runs");
    await ctx.api("DELETE", `/api/script-runs/${asString(asRecord(afterCap.json).id, "id")}`);
    for (const id of [taskRunId, failId]) await ctx.api("DELETE", `/api/script-runs/${id}`);

    // ── parked for the state-surface gate: one run aborted by a limit, one left paused ──
    // The 51st journaled agent-task step exceeds SCRIPT_RUN_MAX_AGENT_TASKS (default 50): the
    // journal write answers 429 and the run ends aborted_limit. Neither run is cancelled.
    const limitRunId = await createRun(
      ctx,
      launcherId,
      { source: NOOP, background: false },
      "run to abort on a limit",
    );
    let limited: Record<string, unknown> | undefined;
    for (let step = 1; step <= 60 && !limited; step += 1) {
      const wrote = await ctx.api("POST", `/api/internal/script-runs/${limitRunId}/steps`, {
        body: { stepKey: `limit-${step}`, stepType: "agent-task", status: "completed" },
      });
      if (wrote.status === 429) limited = asRecord(wrote.json);
      else expectStatus(wrote, [201], "journal an agent-task step under the limit");
    }
    expect(limited, "the agent-task step limit never refused a journal write");
    expect(
      limited.error === "script_run_limit" &&
        String(limited.message).includes("SCRIPT_RUN_MAX_AGENT_TASKS"),
      `429 limit body is wrong: ${JSON.stringify(limited)}`,
    );
    const aborted = asRecord(
      asRecord((await ctx.api("GET", `/api/script-runs/${limitRunId}`)).json).run,
    );
    expect(
      aborted.status === "aborted_limit" &&
        typeof aborted.finishedAt === "string" &&
        String(aborted.error).includes("SCRIPT_RUN_MAX_AGENT_TASKS"),
      `a run over the step limit must end aborted_limit: ${JSON.stringify(aborted)}`,
    );

    const parkedRunId = await createRun(
      ctx,
      launcherId,
      { source: NOOP, background: false },
      "run to leave paused",
    );
    expectStatus(
      await ctx.api("POST", `/api/internal/script-runs/${parkedRunId}/status`, {
        body: { status: "paused" },
      }),
      [204],
      "pause the parked run",
    );
    expect(
      asRecord(asRecord((await ctx.api("GET", `/api/script-runs/${parkedRunId}`)).json).run)
        .status === "paused",
      "the parked run must be paused",
    );

    // ── C. MCP tools: launch-script-run, get-script-run, list-script-runs ──
    await withMcp(ctx, launcherId, async (mcp) => {
      const toolKey = `e2e-tool-run-${ctx.nonce}`;
      const launched = await callToolOk(mcp, "launch-script-run", {
        source: `export default async function (args: { v: number }, ctx: any) {
  const llm = await ctx.step.rawLlm("tool-ask", { prompt: "tool run ${ctx.nonce}" });
  return { v: args.v + 1, llm };
}`,
        args: { v: 1 },
        scriptName: `e2e-tool-run-${ctx.nonce}`,
        idempotencyKey: toolKey,
      });
      const toolRunId = asString(asRecord(structured(launched).data).id, "tool run id");
      expect(toolText(launched).includes(`Script run launched: ${toolRunId}`), "launch text");
      const again = await callToolErr(mcp, "launch-script-run", {
        source: NOOP,
        idempotencyKey: toolKey,
      });
      expect(structured(again).status === 409, "a repeated idempotencyKey must surface the 409");

      const finishedTool = await waitForTerminalRun(ctx, toolRunId);
      expect(finishedTool.run.status === "completed", "the tool-launched run must complete");
      const got = await callToolOk(mcp, "get-script-run", { id: toolRunId });
      expect(
        toolText(got).includes("status: completed") && toolText(got).includes("tool-ask"),
        `get-script-run must render the status and the journal: ${toolText(got).slice(0, 300)}`,
      );
      const gotData = asRecord(structured(got).data);
      expect(
        asRecord(gotData.run).id === toolRunId && asRecords(gotData, "journal").length === 1,
        "get-script-run structured data lost the run or journal",
      );
      const missingRun = await callToolErr(mcp, "get-script-run", { id: UNKNOWN_ID });
      expect(structured(missingRun).status === 404, "get-script-run of an unknown id must be 404");

      const listed = await callToolOk(mcp, "list-script-runs", {
        status: "completed",
        agentId: launcherId,
        limit: 50,
      });
      const listedData = asRecord(structured(listed).data);
      expect(
        asRecords(listedData, "runs").some((entry) => entry.id === toolRunId) &&
          asRecords(listedData, "runs").some((entry) => entry.id === runId) &&
          Number(listedData.total) >= 2,
        "list-script-runs must list both completed runs of the launcher",
      );
      expect(toolText(listed).includes(toolRunId), "list-script-runs text must name the run");
    });

    await worker.stop();
  },
};
