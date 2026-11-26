import { sql } from "../db";
import { type ApiResponse, asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callToolOk, expectRunOk, registerAgent, runScript, withMcp } from "./script-helpers";

const EXECUTORS = ["native", "quickjs"] as const;
const REPLAYED = "idempotent-replayed";

/** A durable run: two auto-keyed writes of one tool, one explicitly keyed write, then a wait. */
const DURABLE_SOURCE = `export default async function (args: any, ctx: any) {
  const first = await ctx.swarm.kv_incr({ namespace: args.ns, key: "auto" });
  const second = await ctx.swarm.kv_incr({ namespace: args.ns, key: "auto" });
  const explicit = await ctx.swarm.kv_incr(
    { namespace: args.ns, key: "explicit" },
    { idempotencyKey: args.fixedKey },
  );
  const done = await ctx.step.agentTask("wait", { task: args.task, agentId: args.workerId });
  return {
    first: first.entry.value,
    second: second.entry.value,
    explicit: explicit.entry.value,
    done,
  };
}`;

/** A one-off run: the same keyed send twice, and a key on a REST-routed method. */
const INLINE_SOURCE = `export default async function (args: any, ctx: any) {
  const send = () =>
    ctx.swarm.task_send(
      {
        task: args.task,
        agentId: args.workerId,
        routingReason: "human_pinned",
        routingNote: "e2e idempotent send to a fixed worker",
        // Turn off send-task's own similarity check: only the key may dedupe here.
        allowDuplicate: true,
      },
      { idempotencyKey: args.key },
    );
  const first = await send();
  const second = await send();
  let rest: unknown = "resolved";
  try {
    await ctx.swarm.kv_incr({ namespace: args.ns, key: "rest" }, { idempotencyKey: args.key });
  } catch (error: any) {
    rest = { code: error.code, tool: error.tool, message: error.message };
  }
  return { first, second, rest };
}`;

/** A child run: one unkeyed send. Started by RUN_KEYED_SOURCE through ctx.swarm.script_run. */
const NESTED_SOURCE = `export default async function (args: any, ctx: any) {
  await ctx.swarm.task_send({
    task: args.task,
    agentId: args.workerId,
    routingReason: "human_pinned",
    routingNote: "e2e run-keyed nested send to a fixed worker",
    allowDuplicate: true,
  });
  return "nested";
}`;

/**
 * A run started with a run-level idempotencyKey: two unkeyed sends, a nested
 * script_run that sends, and a REST-routed write. None of them passes a key.
 */
const RUN_KEYED_SOURCE = `export default async function (args: any, ctx: any) {
  const send = (suffix: string) =>
    ctx.swarm.task_send({
      task: args.task + " " + suffix,
      agentId: args.workerId,
      routingReason: "human_pinned",
      routingNote: "e2e run-keyed send to a fixed worker",
      allowDuplicate: true,
    });
  await send("a");
  await send("b");
  await ctx.swarm.script_run({
    source: args.nested,
    args: { task: args.task + " nested", workerId: args.workerId },
    intent: "e2e run-keyed nested send",
  });
  await ctx.swarm.kv_incr({ namespace: args.ns, key: args.restKey });
  return "parent";
}`;

function entryValue(response: ApiResponse): unknown {
  return asRecord(asRecord(response.json).entry).value;
}

/**
 * Flow `script-tool-idempotency`: an `Idempotency-Key` on the scripts MCP bridge runs a
 * write once and answers repeats from the first result; read-only tools, refusals and
 * calls without a key run every time. A one-off run started with an idempotencyKey (API or
 * MCP tool) keys each ctx.swarm call from it, nested script_run included. A durable run keys each ctx.swarm call from its run,
 * tool and call ordinal, so the re-execution after an API restart repeats no write.
 */
export const scriptToolIdempotency: Scenario = {
  name: "script-tool-idempotency",
  order: 451,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "idem");
    const otherId = await registerAgent(ctx, "idem-other");
    const ns = `e2e-idem-${ctx.nonce}`;
    const bridge = (tool: string, args: Record<string, unknown>, key?: string, as = agentId) =>
      ctx.api("POST", "/api/mcp-bridge", {
        agentId: as,
        body: { tool, args },
        ...(key === undefined ? {} : { headers: { "Idempotency-Key": key } }),
      });

    // ── A. the bridge: replay, distinct keys, no key, read-only, scope, refusals ──
    const k1 = `k1-${ctx.nonce}`;
    const first = await bridge("kv-incr", { namespace: ns, key: "direct" }, k1);
    expectStatus(first, [200], "keyed write");
    expect(entryValue(first) === 1 && !first.headers.get(REPLAYED), "first keyed write must run");
    const repeat = await bridge("kv-incr", { namespace: ns, key: "direct", by: 5 }, k1);
    expectStatus(repeat, [200], "repeated keyed write");
    expect(
      repeat.headers.get(REPLAYED) === "true" && repeat.text === first.text,
      `a repeat must return the first result, whatever its args: ${repeat.text}`,
    );
    const distinct = await bridge("kv-incr", { namespace: ns, key: "direct" }, `k2-${ctx.nonce}`);
    expect(entryValue(distinct) === 2, `a distinct key must run again: ${distinct.text}`);
    const plainA = await bridge("kv-incr", { namespace: ns, key: "direct" });
    const plainB = await bridge("kv-incr", { namespace: ns, key: "direct" });
    expect(
      entryValue(plainA) === 3 && entryValue(plainB) === 4,
      "calls without a key must keep running every time",
    );
    const readKey = `read-${ctx.nonce}`;
    const readA = await bridge("kv-get", { namespace: ns, key: "direct" }, readKey);
    await bridge("kv-incr", { namespace: ns, key: "direct" });
    const readB = await bridge("kv-get", { namespace: ns, key: "direct" }, readKey);
    expect(
      entryValue(readA) === 4 && entryValue(readB) === 5 && !readB.headers.get(REPLAYED),
      `a read-only tool must ignore the key: ${readA.text} / ${readB.text}`,
    );
    const otherCaller = await bridge("kv-incr", { namespace: ns, key: "direct" }, k1, otherId);
    expect(
      entryValue(otherCaller) === 6 && !otherCaller.headers.get(REPLAYED),
      "a key must be scoped to its caller",
    );
    // A refusal records nothing: the same key runs again once the call can succeed.
    const refusedKey = `refused-${ctx.nonce}`;
    expectStatus(
      await bridge("kv-set", { namespace: ns, key: "typed", value: "text" }),
      [200],
      "seed a text entry",
    );
    const refused = await bridge("kv-incr", { namespace: ns, key: "typed" }, refusedKey);
    expect(
      asRecord(refused.json).success === false,
      `incrementing a text entry must be refused: ${refused.text}`,
    );
    await bridge("kv-delete", { namespace: ns, key: "typed" });
    const retried = await bridge("kv-incr", { namespace: ns, key: "typed" }, refusedKey);
    expect(
      entryValue(retried) === 1 && !retried.headers.get(REPLAYED),
      `a refused call must not use up its key: ${retried.text}`,
    );
    expectStatus(
      await bridge("kv-incr", { namespace: ns, key: "direct" }, "not a key"),
      [400],
      "malformed Idempotency-Key",
    );
    const privateRead = await bridge("kv-list", { namespace: "tool-call-idempotency" });
    expect(
      asRecord(privateRead.json).success === false,
      `recorded results must not be readable through generic KV: ${privateRead.text}`,
    );

    // ── B. one-off runs: no key by default, an explicit key dedupes, REST methods refuse it ──
    const workerId = await registerAgent(ctx, "idem-worker");
    for (const executor of EXECUTORS) {
      const task = `e2e idempotent send ${executor} ${ctx.nonce}`;
      const run = await runScript(ctx, agentId, {
        source: INLINE_SOURCE,
        args: { task, workerId, ns, key: `send-${executor}-${ctx.nonce}` },
        executor,
        intent: `e2e tool idempotency ${executor} ${ctx.nonce}`,
      });
      expectRunOk(run, `keyed sends (${executor})`);
      const result = asRecord(run.result);
      expect(
        JSON.stringify(asRecord(result.first).data) ===
          JSON.stringify(asRecord(result.second).data),
        `the repeated send must return the first result (${executor}): ${JSON.stringify(result)}`,
      );
      const created = ctx.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM agent_tasks WHERE task = ${task}`,
      )?.n;
      expect(
        created === 1,
        `a keyed send repeated in one run must create one task (${executor}), got ${created}: ${JSON.stringify(result).slice(0, 600)}`,
      );
      const rest = asRecord(result.rest);
      expect(
        rest.code === "invalid_args" &&
          rest.tool === "kv_incr" &&
          String(rest.message).includes("does not take an idempotencyKey"),
        `a REST-routed method must refuse the option (${executor}): ${JSON.stringify(rest)}`,
      );
    }

    // ── C. a run-level idempotencyKey keys every ctx.swarm call, nested script_run included ──
    for (const executor of EXECUTORS) {
      await runKeyedRerun(ctx, { agentId, workerId, ns, executor, bridge });
    }

    // ── D. a durable run re-executed after an API restart repeats none of its writes ──
    const durableWorker = await registerAgent(ctx, "idem-durable-worker");
    const fixedKey = `fixed-${ctx.nonce}`;
    const durableNs = `${ns}-durable`;
    const launched = await ctx.api("POST", "/api/script-runs", {
      agentId,
      body: {
        source: DURABLE_SOURCE,
        args: {
          ns: durableNs,
          workerId: durableWorker,
          task: `idempotent resume ${ctx.nonce}`,
          fixedKey,
        },
        scriptName: `e2e-idem-resume-${ctx.nonce}`,
      },
    });
    expectStatus(launched, [201], "launch the durable run");
    const runId = asString(asRecord(launched.json).id, "durable run id");
    try {
      await runDurableAcrossRestart(ctx, { runId, durableWorker, durableNs, fixedKey, bridge });
    } finally {
      await ctx.api("DELETE", `/api/script-runs/${runId}`);
    }
  },
};

/**
 * The same run under one run key, first through `POST /api/scripts/run`, then
 * through the `script-run` MCP tool: the second repeats no bridge write, in the
 * parent or in its nested run, while a REST-routed write runs again. A third
 * run under another key repeats every write.
 */
async function runKeyedRerun(
  ctx: ScenarioContext,
  input: {
    agentId: string;
    workerId: string;
    ns: string;
    executor: (typeof EXECUTORS)[number];
    bridge: (tool: string, args: Record<string, unknown>, key?: string) => Promise<ApiResponse>;
  },
): Promise<void> {
  const { agentId, workerId, ns, executor, bridge } = input;
  const task = `e2e run-keyed ${executor} ${ctx.nonce}`;
  const restKey = `run-keyed-rest-${executor}`;
  const body = (idempotencyKey: string) => ({
    source: RUN_KEYED_SOURCE,
    args: { task, workerId, ns, restKey, nested: NESTED_SOURCE },
    executor,
    intent: `e2e run-keyed ${executor} ${ctx.nonce}`,
    idempotencyKey,
  });
  const counts = () =>
    Object.fromEntries(
      ["a", "b", "nested"].map((suffix) => [
        suffix,
        ctx.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM agent_tasks WHERE task = ${`${task} ${suffix}`}`,
        )?.n,
      ]),
    );
  const restValue = async () => entryValue(await bridge("kv-get", { namespace: ns, key: restKey }));

  const runKey = `run-${executor}-${ctx.nonce}`;
  const first = await runScript(ctx, agentId, body(runKey), `run-keyed first (${executor})`);
  expectRunOk(first, `run-keyed first (${executor})`);
  const afterFirst = counts();
  expect(
    afterFirst.a === 1 && afterFirst.b === 1 && afterFirst.nested === 1,
    `the first keyed run must send each task once (${executor}): ${JSON.stringify(afterFirst)}`,
  );

  // The same run key through the MCP tool: the api derives the same per-call keys.
  const viaTool = await withMcp(ctx, agentId, (mcp) =>
    callToolOk(mcp, "script-run", body(runKey)),
  );
  const toolRun = asRecord(asRecord(viaTool.structuredContent).data ?? viaTool.structuredContent);
  expect(
    toolRun.exitCode === undefined || toolRun.exitCode === 0,
    `the keyed re-run through the MCP tool must succeed (${executor}): ${JSON.stringify(viaTool).slice(0, 500)}`,
  );
  const afterRerun = counts();
  expect(
    afterRerun.a === 1 && afterRerun.b === 1 && afterRerun.nested === 1,
    `a re-run under the same run key must repeat no send, nested ones included (${executor}): ${JSON.stringify(afterRerun)}`,
  );
  expect(
    (await restValue()) === 2,
    `the re-run must execute, and its REST-routed write runs again (${executor})`,
  );

  const other = await runScript(
    ctx,
    agentId,
    body(`other-${executor}-${ctx.nonce}`),
    `run-keyed other key (${executor})`,
  );
  expectRunOk(other, `run-keyed other key (${executor})`);
  const afterOther = counts();
  expect(
    afterOther.a === 2 && afterOther.b === 2 && afterOther.nested === 2,
    `another run key must send every task again (${executor}): ${JSON.stringify(afterOther)}`,
  );
}

async function runDurableAcrossRestart(
  ctx: ScenarioContext,
  input: {
    runId: string;
    durableWorker: string;
    durableNs: string;
    fixedKey: string;
    bridge: (tool: string, args: Record<string, unknown>, key?: string) => Promise<ApiResponse>;
  },
): Promise<void> {
  const { runId, durableWorker, durableNs, fixedKey, bridge } = input;
  const contextKey = `script-run:${runId}:wait`;
  let taskId = "";
  const waiting = await pollUntil(() => {
    const task = ctx.db.get<{ id: string }>(
      sql`SELECT id FROM agent_tasks WHERE "contextKey" = ${contextKey} AND "taskType" = 'script-run-step'`,
    );
    if (task) taskId = task.id;
    return Boolean(task);
  }, 30_000);
  expect(waiting, `durable run never reached its waiting step: ${await ctx.sutLog()}`);
  const counters = async () => ({
    auto: entryValue(await bridge("kv-get", { namespace: durableNs, key: "auto" })),
    explicit: entryValue(await bridge("kv-get", { namespace: durableNs, key: "explicit" })),
  });
  const before = await counters();
  expect(
    before.auto === 2 && before.explicit === 1,
    `the first execution must write each counter: ${JSON.stringify(before)}`,
  );

  // The restart kills the run's process; the supervisor re-executes the script from the top.
  await ctx.restartSut();
  const worker = await ctx.startAgent({
    agentId: durableWorker,
    onTask: () => ({ status: "completed", output: `idem-resumed-${ctx.nonce}` }),
  });
  await worker.waitForTask(taskId);
  await worker.stop();
  let run: Record<string, unknown> = {};
  const finished = await pollUntil(async () => {
    const detail = await ctx.api("GET", `/api/script-runs/${runId}`);
    expectStatus(detail, [200], "poll the restarted durable run");
    run = asRecord(asRecord(detail.json).run);
    return ["completed", "failed", "cancelled", "aborted_limit"].includes(String(run.status));
  }, 60_000);
  expect(
    finished && run.status === "completed",
    `the restarted run must complete: ${JSON.stringify(run)}`,
  );
  const output = asRecord(run.output);
  expect(
    output.first === 1 &&
      output.second === 2 &&
      output.explicit === 1 &&
      output.done === `idem-resumed-${ctx.nonce}`,
    `the re-execution must get the first execution's results back: ${JSON.stringify(output)}`,
  );
  const after = await counters();
  expect(
    after.auto === 2 && after.explicit === 1,
    `the re-execution must not repeat a write: ${JSON.stringify(after)}`,
  );
  // The explicit key is the agent's own, not the run's: it dedupes outside the run too.
  const outside = await bridge("kv-incr", { namespace: durableNs, key: "explicit" }, fixedKey);
  expect(
    outside.headers.get(REPLAYED) === "true" && entryValue(outside) === 1,
    `an explicit key must replace the run-derived one: ${outside.text}`,
  );
}
