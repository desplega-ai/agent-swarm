import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { expectRunOk, registerAgent, runScript, startStub } from "./script-helpers";

const SDK_SCRIPT = `export default async function (args: { marker: string; taskId: string; origin: string | null }, ctx: any) {
  const out: Record<string, unknown> = {};
  const key = "sdk-" + args.marker;
  out.kvSet = await ctx.swarm.kv_set({ key, value: { marker: args.marker } });
  out.kvGet = await ctx.swarm.kv_get({ key });
  out.kvMissing = await ctx.swarm.kv_get({ key: "missing-" + args.marker });
  out.kvIncr = await ctx.swarm.kv_incr({ key: "ctr-" + args.marker, by: 3 });
  out.kvList = await ctx.swarm.kv_list({ prefix: "sdk-" });
  out.agent = await ctx.swarm.agent_info({});
  out.progress = await ctx.swarm.task_storeProgress({ taskId: args.taskId, progress: "progress " + args.marker });
  out.task = await ctx.swarm.task_get({ taskId: args.taskId });
  out.tasks = await ctx.swarm.task_list({});
  out.dbRead = await ctx.swarm.db_query({ sql: "SELECT count(*) AS n FROM agents" });
  out.dbWrite = await ctx.swarm.db_query({ sql: "DELETE FROM agents" });
  ctx.logger.log("logged " + args.marker);

  // ctx.fs and ctx.sh share one in-memory scratch filesystem per run.
  await ctx.fs.mkdir("/scratch/deep/er", { recursive: true });
  await ctx.fs.writeFile("/scratch/a.txt", "alpha\\nbeta " + args.marker + "\\n");
  await ctx.fs.appendFile("/scratch/a.txt", "gamma\\n");
  const fs: Record<string, unknown> = {};
  fs.read = await ctx.fs.readFile("/scratch/a.txt");
  fs.exists = [await ctx.fs.exists("/scratch/a.txt"), await ctx.fs.exists("/scratch/none.txt")];
  fs.stat = await ctx.fs.stat("/scratch/a.txt");
  await ctx.fs.cp("/scratch/a.txt", "/scratch/deep/er/copy.txt");
  await ctx.fs.mv("/scratch/deep/er/copy.txt", "/scratch/deep/moved.txt");
  fs.ls = await ctx.fs.readdir("/scratch/deep");
  fs.grep = await ctx.sh("grep -c a /scratch/a.txt");
  fs.pipe = await ctx.sh("cat /scratch/a.txt | sort -r | head -n 1");
  fs.jq = await ctx.sh("echo '{\\"a\\":[1,2,3]}' | jq '.a | length'");
  fs.stdin = await ctx.sh("cat", { stdin: "from-stdin" });
  fs.env = await ctx.sh("echo $E2E_VAR", { env: { E2E_VAR: "from-env" } });
  fs.fail = await ctx.sh("exit 3");
  await ctx.fs.rm("/scratch/deep", { recursive: true });
  fs.afterRm = await ctx.fs.exists("/scratch/deep/moved.txt");
  try {
    await ctx.fs.readFile("/afs/notes.txt");
    fs.afs = "readable";
  } catch (error: any) {
    fs.afs = String(error?.message ?? error);
  }
  out.fs = fs;

  out.table = ctx.stdlib.table([{ id: 1, name: "x" }]);
  out.hasRedacted = typeof ctx.stdlib.Redacted;
  out.fetched = args.origin ? await ctx.stdlib.fetchJson(args.origin + "/stdlib") : null;
  return out;
}`;

async function runSdkScript(
  ctx: ScenarioContext,
  agentId: string,
  taskId: string,
  executor: "native" | "quickjs",
  origin: string | null,
) {
  const marker = `${executor}-${ctx.nonce}`;
  const run = await runScript(ctx, agentId, {
    source: SDK_SCRIPT,
    args: { marker, taskId, origin },
    executor,
    intent: `e2e sdk ${executor} ${ctx.nonce}`,
  });
  expectRunOk(run, `sdk script on ${executor}`);
  return { run, marker, out: asRecord(run.result) };
}

function expectSdkResults(
  ctx: ScenarioContext,
  agentId: string,
  taskId: string,
  executor: string,
  marker: string,
  out: Record<string, unknown>,
  stdout: string,
): void {
  const label = `sdk script (${executor})`;
  const namespace = `task:agent:${agentId}`;
  const kvSet = asRecord(out.kvSet);
  expect(
    kvSet.success === true &&
      kvSet.status === 200 &&
      asRecord(kvSet.data).namespace === namespace &&
      asRecord(asRecord(kvSet.data).value).marker === marker,
    `${label}: kv_set did not write in the agent namespace: ${JSON.stringify(kvSet)}`,
  );
  expect(
    asRecord(asRecord(out.kvGet).data).key === `sdk-${marker}`,
    `${label}: kv_get lost the key`,
  );
  const missing = asRecord(out.kvMissing);
  expect(missing.success === false && missing.status === 404, `${label}: missing key must 404`);
  expect(asRecord(asRecord(out.kvIncr).data).value === 3, `${label}: kv_incr must start at 3`);
  expect(
    asRecord(asRecord(out.kvList).data).namespace === namespace,
    `${label}: kv_list used the wrong namespace`,
  );
  expect(
    asRecord(asRecord(out.agent).data).id === agentId,
    `${label}: agent_info is not this agent`,
  );

  const progress = asRecord(out.progress);
  expect(
    progress.success === true,
    `${label}: task_storeProgress failed: ${JSON.stringify(progress)}`,
  );
  expect(
    asRecord(asRecord(out.task).data).id === taskId,
    `${label}: task_get did not return the task`,
  );
  expect(
    Array.isArray(asRecord(asRecord(out.tasks).data).tasks),
    `${label}: task_list has no tasks array`,
  );

  const dbRead = asRecord(asRecord(out.dbRead).data);
  const firstRow = Array.isArray(dbRead.rows) ? (dbRead.rows[0] as unknown[]) : [];
  expect(
    JSON.stringify(dbRead.columns) === JSON.stringify(["n"]) && Number(firstRow[0]) >= 1,
    `${label}: db_query select returned ${JSON.stringify(dbRead)}`,
  );
  const dbWrite = asRecord(out.dbWrite);
  expect(
    dbWrite.success === false &&
      dbWrite.status === 400 &&
      String(asRecord(dbWrite.data).error).includes("read-only"),
    `${label}: db_query must refuse writes: ${JSON.stringify(dbWrite)}`,
  );
  expect(stdout.includes(`logged ${marker}`), `${label}: ctx.logger output is missing from stdout`);

  // The SDK wrote through to the real stores: assert them from outside the script.
  const row = ctx.db.get<{ value: string; value_type: string }>(
    "SELECT value, value_type FROM kv_entries WHERE namespace = ? AND key = ?",
    [namespace, `ctr-${marker}`],
  );
  expect(
    row?.value === "3" && row.value_type === "integer",
    `${label}: kv_incr did not persist an integer`,
  );

  const fs = asRecord(out.fs);
  expect(fs.read === `alpha\nbeta ${marker}\ngamma\n`, `${label}: ctx.fs read/append mismatch`);
  expect(
    JSON.stringify(fs.exists) === JSON.stringify([true, false]),
    `${label}: ctx.fs.exists mismatch`,
  );
  const stat = asRecord(fs.stat);
  expect(
    stat.isFile === true && stat.isDirectory === false && stat.size === String(fs.read).length,
    `${label}: ctx.fs.stat mismatch: ${JSON.stringify(stat)}`,
  );
  expect(
    JSON.stringify(fs.ls) === JSON.stringify(["er", "moved.txt"]),
    `${label}: ctx.fs cp/mv/readdir mismatch: ${JSON.stringify(fs.ls)}`,
  );
  expect(asRecord(fs.grep).stdout === "3\n", `${label}: sh grep -c mismatch`);
  expect(asRecord(fs.pipe).stdout === "gamma\n", `${label}: sh pipeline mismatch`);
  expect(asRecord(fs.jq).stdout === "3\n", `${label}: sh jq mismatch`);
  expect(asRecord(fs.stdin).stdout === "from-stdin", `${label}: sh stdin mismatch`);
  expect(asRecord(fs.env).stdout === "from-env\n", `${label}: sh env mismatch`);
  const failed = asRecord(fs.fail);
  expect(failed.exitCode === 3, `${label}: sh must surface a non-zero exit code`);
  expect(fs.afterRm === false, `${label}: ctx.fs.rm -r left the file behind`);
  // /afs mounts only with an agent-scoped agent-fs key; none exists in this environment.
  expect(
    String(fs.afs).includes("ENOENT") && String(fs.afs).includes("agent-fs is not configured"),
    `${label}: /afs must report that agent-fs is not configured, got ${String(fs.afs)}`,
  );
  expect(String(out.table).includes("id") && String(out.table).includes("name"), `${label}: table`);
  expect(out.hasRedacted === "object" || out.hasRedacted === "function", `${label}: Redacted`);
}

/**
 * Flow `script-sdk-calls`: a script calls ctx.swarm.* (the MCP bridge: kv, agent, tasks,
 * read-only SQL), ctx.fs / ctx.sh (scratch filesystem, /afs unmounted), ctx.stdlib and
 * ctx.logger, on both executors, and the effects are visible from outside through the API.
 */
export const scriptSdkCalls: Scenario = {
  name: "script-sdk-calls",
  order: 420,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "sdk");
    const task = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `sdk progress task ${ctx.nonce}`,
        agentId,
        source: "api",
        routingReason: "human_pinned",
      },
    });
    expectStatus(task, [201], "create the task the script reports progress on");
    const taskId = String(asRecord(task.json).id);

    const stub = startStub(() => Response.json({ via: "stdlib.fetchJson" }));
    try {
      // native: full surface including stdlib.fetchJson against a loopback stub
      const native = await runSdkScript(ctx, agentId, taskId, "native", stub.origin);
      expectSdkResults(
        ctx,
        agentId,
        taskId,
        "native",
        native.marker,
        native.out,
        String(native.run.stdout),
      );
      expect(
        JSON.stringify(native.out.fetched) === JSON.stringify({ via: "stdlib.fetchJson" }),
        "ctx.stdlib.fetchJson did not reach the stub",
      );
      expect(
        stub.seen.some((request) => request.path === "/stdlib"),
        "the stub never received the stdlib request",
      );

      // quickjs: the same SDK and filesystem surface, host-side
      const quick = await runSdkScript(ctx, agentId, taskId, "quickjs", null);
      expectSdkResults(
        ctx,
        agentId,
        taskId,
        "quickjs",
        quick.marker,
        quick.out,
        String(quick.run.stdout),
      );
    } finally {
      stub.stop();
    }

    // the progress the script stored is visible on the task itself
    const stored = await ctx.api("GET", `/api/tasks/${taskId}`);
    expectStatus(stored, [200], "read the task");
    const storedTask = asRecord(stored.json);
    expect(
      String(storedTask.progress).startsWith("progress ") && storedTask.status === "in_progress",
      `task_storeProgress did not update the task: ${stored.text.slice(0, 300)}`,
    );
    const kvEntry = await ctx.api("GET", `/api/kv/_/task:agent:${agentId}/sdk-native-${ctx.nonce}`);
    expectStatus(kvEntry, [200], "read the script's KV write");
    expect(
      asRecord(asRecord(kvEntry.json).value).marker === `native-${ctx.nonce}`,
      "KV value written by the script is wrong",
    );

    // the scratch filesystem dies with the run
    const later = await runScript(ctx, agentId, {
      source: `export default async function (args: unknown, ctx: any) { return { gone: !(await ctx.fs.exists("/scratch/a.txt")) }; }`,
      intent: `e2e scratch gone ${ctx.nonce}`,
    });
    expect(asRecord(later.result).gone === true, "ctx.fs state leaked across runs");

    // a script that throws inside an SDK-using body surfaces the message, not a hang
    const failing = await runScript(ctx, agentId, {
      source: `export default async function (args: unknown, ctx: any) { await ctx.swarm.kv_set({ key: "boom-${ctx.nonce}", value: 1 }); throw new Error("after-sdk-${ctx.nonce}"); }`,
      intent: `e2e sdk failing ${ctx.nonce}`,
    });
    expect(
      failing.error === "eval_error" &&
        asRecord(failing.runtimeError).message === `after-sdk-${ctx.nonce}`,
      "a throw after an SDK call must fail the run with the message",
    );
    const sideEffect = await ctx.api("GET", `/api/kv/_/task:agent:${agentId}/boom-${ctx.nonce}`);
    expectStatus(sideEffect, [200], "SDK writes before a throw are not rolled back");
  },
};
