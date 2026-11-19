import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getDbClient,
  getLogsByTaskIdAndEventType,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import * as savedScriptRunner from "../be/scripts/run-saved";
import { validateConfigValue } from "../be/swarm-config-guard";
import type { RunScriptOutput } from "../scripts-runtime/loader";
import {
  classifyFollowUpGate,
  drainFollowUpGateShadowForTest,
  type FollowUpGateDeps,
  readFollowUpGateConfig,
  setFollowUpGateDepsForTests,
  setFollowUpGateTimeoutMsForTests,
} from "../tasks/follow-up-gate";
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import type { AgentTask } from "../types";

const GATED = "11111111-1111-4111-8111-111111111111";
const NOT_GATED = "22222222-2222-4222-8222-222222222222";
const ENV_KEYS = [
  "FOLLOW_UP_GATE_MODE",
  "FOLLOW_UP_GATE_SCHEDULE_IDS",
  "FOLLOW_UP_GATE_ENFORCE_SCHEDULE_IDS",
  "FOLLOW_UP_GATE_VERIFIER_SCRIPT",
] as const;

const VERIFIER = { name: "test-verifier", version: 3, contentHash: "abc123" };

let leadId: string;
let workerId: string;

beforeAll(async () => {
  initDb(":memory:");
  leadId = (
    await createAgent({
      name: "Lead",
      isLead: true,
      status: "busy",
      capabilities: [],
      maxTasks: 50,
    })
  ).id;
  workerId = (
    await createAgent({
      name: "Worker",
      isLead: false,
      status: "busy",
      capabilities: [],
      maxTasks: 50,
    })
  ).id;
});

afterEach(async () => {
  await drainFollowUpGateShadowForTest();
  setFollowUpGateDepsForTests(null);
  setFollowUpGateTimeoutMsForTests(null);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => closeDb());

function shadowEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  process.env.FOLLOW_UP_GATE_MODE = "shadow";
  process.env.FOLLOW_UP_GATE_SCHEDULE_IDS = GATED;
  process.env.FOLLOW_UP_GATE_VERIFIER_SCRIPT = VERIFIER.name;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

/** Deps that record calls; `run` decides the verifier result. */
function stubDeps(run: FollowUpGateDeps["runVerifier"]) {
  const calls = { getVerifier: 0, runVerifier: 0 };
  const deps: FollowUpGateDeps = {
    getVerifier: async () => {
      calls.getVerifier++;
      return VERIFIER;
    },
    runVerifier: async (...args) => {
      calls.runVerifier++;
      return run(...args);
    },
  };
  setFollowUpGateDepsForTests(deps);
  return calls;
}

async function workerTask(options: Parameters<typeof createTaskExtended>[1] = {}) {
  const task = await createTaskExtended("scheduled work", {
    agentId: workerId,
    scheduleId: GATED,
    ...options,
  });
  await startTask(task.id);
  return (await getTaskById(task.id)) as AgentTask;
}

async function shadowRows(taskId: string) {
  await drainFollowUpGateShadowForTest();
  const rows = await getLogsByTaskIdAndEventType(taskId, "task_follow_up_gate_shadow");
  return rows.map((row) => ({ ...row, meta: JSON.parse(row.metadata ?? "{}") }));
}

async function finish(task: AgentTask, status: "completed" | "failed" = "completed") {
  const followUp = await createWorkerTaskFollowUp({ task, status, output: "done" });
  expect(followUp).not.toBeNull();
  expect(followUp?.parentTaskId).toBe(task.id);
  expect(await getTaskById(followUp!.id)).not.toBeNull();
  return followUp!;
}

describe("classifyFollowUpGate", () => {
  const shadow = readFollowUpGateConfig({
    FOLLOW_UP_GATE_MODE: "shadow",
    FOLLOW_UP_GATE_SCHEDULE_IDS: `${GATED}, not-a-uuid`,
  });
  const classify = (
    task: Pick<AgentTask, "scheduleId" | "followUpConfig">,
    status: "completed" | "failed" = "completed",
    config = shadow,
  ) => classifyFollowUpGate({ task, status, config });

  test("a completed run of a gated schedule is eligible", () => {
    expect(classify({ scheduleId: GATED })).toEqual({ eligible: true });
    expect(classify({ scheduleId: GATED.toUpperCase() })).toEqual({ eligible: true });
  });

  test("a failed run is ineligible", () => {
    expect(classify({ scheduleId: GATED }, "failed")).toEqual({
      eligible: false,
      reason: "status_failed",
    });
  });

  test("follow-up instructions make a run ineligible", () => {
    for (const followUpConfig of [{ onCompleted: "post it" }, { onFailed: "retry it" }]) {
      expect(classify({ scheduleId: GATED, followUpConfig })).toEqual({
        eligible: false,
        reason: "follow_up_instructions",
      });
    }
  });

  test("a task with no schedule is not scheduled", () => {
    expect(classify({})).toEqual({ eligible: false, reason: "not_scheduled" });
  });

  test("a schedule off the list is not gated", () => {
    expect(classify({ scheduleId: NOT_GATED })).toEqual({
      eligible: false,
      reason: "schedule_not_gated",
    });
  });

  test("mode off and an unknown mode read as off", () => {
    for (const mode of [undefined, "off", "enforcing", "SHADOWY"]) {
      const config = readFollowUpGateConfig({
        FOLLOW_UP_GATE_MODE: mode,
        FOLLOW_UP_GATE_SCHEDULE_IDS: GATED,
      });
      expect(classify({ scheduleId: GATED }, "completed", config)).toEqual({
        eligible: false,
        reason: "mode_off",
      });
    }
  });

  test("malformed ids in the list are ignored", () => {
    expect([...shadow.scheduleIds]).toEqual([GATED]);
  });
});

describe("follow-up gate config validation", () => {
  test("mode accepts off, shadow and enforce and rejects anything else", () => {
    for (const mode of ["off", "shadow", "enforce"]) {
      expect(validateConfigValue("FOLLOW_UP_GATE_MODE", mode)).toBeNull();
    }
    expect(validateConfigValue("FOLLOW_UP_GATE_MODE", "skip")).toContain("FOLLOW_UP_GATE_MODE");
  });

  test("schedule ids accept empty and UUID lists and reject other ids", () => {
    for (const key of ["FOLLOW_UP_GATE_SCHEDULE_IDS", "FOLLOW_UP_GATE_ENFORCE_SCHEDULE_IDS"]) {
      expect(validateConfigValue(key, "")).toBeNull();
      expect(validateConfigValue(key, `${GATED}, ${NOT_GATED}`)).toBeNull();
      expect(validateConfigValue(key, `${GATED},daily-report`)).toContain(key);
    }
  });
});

describe("follow-up gate shadow runner", () => {
  test("mode off never looks up the verifier and writes no rows", async () => {
    const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    process.env.FOLLOW_UP_GATE_SCHEDULE_IDS = GATED;
    process.env.FOLLOW_UP_GATE_VERIFIER_SCRIPT = VERIFIER.name;
    const task = await workerTask();
    const followUp = await finish(task);
    expect(followUp.taskType).toBe("follow-up");
    expect(followUp.agentId).toBe(leadId);
    expect(await shadowRows(task.id)).toHaveLength(0);
    expect(calls).toEqual({ getVerifier: 0, runVerifier: 0 });
  });

  test("mode off registers no post-commit hook; shadow registers exactly one", async () => {
    stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const afterCommit = spyOn(getDbClient(), "afterCommit");
    try {
      const hooksFor = async () => {
        const task = await workerTask();
        const before = afterCommit.mock.calls.length;
        await finish(task);
        const count = afterCommit.mock.calls.length - before;
        await drainFollowUpGateShadowForTest();
        return count;
      };
      const off = await hooksFor();
      shadowEnv();
      expect(await hooksFor()).toBe(off + 1);
    } finally {
      afterCommit.mockRestore();
    }
  });

  test("ok:true with passing controls records would_skip", async () => {
    shadowEnv();
    const seen: unknown[] = [];
    stubDeps(async (script, input, agentId) => {
      seen.push({ script: script.name, input, agentId });
      return {
        ok: true,
        check: "page",
        detail: "fresh",
        controls: { ok: true },
        unverified: ["archive"],
      };
    });
    const task = await workerTask();
    const followUp = await finish(task);
    const rows = await shadowRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBe(leadId);
    expect(rows[0]!.meta).toMatchObject({
      v: 1,
      mode: "shadow",
      followUpTaskId: followUp.id,
      scheduleId: GATED,
      status: "completed",
      decision: "would_skip",
      reason: null,
      verdict: { ok: true, check: "page", detail: "fresh", controlsOk: true },
      unverified: ["archive"],
      verifier: VERIFIER,
    });
    expect(rows[0]!.meta.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen).toEqual([{ script: VERIFIER.name, input: { taskId: task.id }, agentId: leadId }]);
  });

  test("ok:false, ok:null and failing controls record would_keep", async () => {
    shadowEnv();
    for (const result of [
      { ok: false, controls: { ok: true } },
      { ok: null, controls: { ok: true } },
      { ok: true, controls: { ok: false } },
      { ok: true },
    ]) {
      stubDeps(async () => result);
      const task = await workerTask();
      await finish(task);
      const rows = await shadowRows(task.id);
      expect(rows.map((row) => row.meta.decision)).toEqual(["would_keep"]);
    }
  });

  test("a verifier throw records a scrubbed error", async () => {
    shadowEnv();
    stubDeps(async () => {
      throw new Error("boom");
    });
    const task = await workerTask();
    await finish(task);
    const rows = await shadowRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({
      decision: "error",
      reason: "verifier_error",
      error: "boom",
      verifier: VERIFIER,
    });
  });

  test("a non-object result records verifier_error", async () => {
    shadowEnv();
    stubDeps(async () => undefined);
    const task = await workerTask();
    await finish(task);
    const rows = await shadowRows(task.id);
    expect(rows[0]!.meta).toMatchObject({ decision: "error", reason: "verifier_error" });
  });

  test("a verifier past the deadline records timeout and is aborted", async () => {
    shadowEnv();
    setFollowUpGateTimeoutMsForTests(20);
    let aborted = false;
    stubDeps(
      (_script, _input, _agentId, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ ok: true, controls: { ok: true } });
          });
        }),
    );
    const task = await workerTask();
    await finish(task);
    const rows = await shadowRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ decision: "error", reason: "timeout" });
    expect(aborted).toBe(true);
  });

  test("the follow-up returns before the verifier settles", async () => {
    shadowEnv();
    let release!: (value: unknown) => void;
    let started = false;
    stubDeps(() => {
      started = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const task = await workerTask();
    const followUp = await finish(task);
    expect(followUp.id).toBeTruthy();
    expect(await getLogsByTaskIdAndEventType(task.id, "task_follow_up_gate_shadow")).toHaveLength(
      0,
    );
    while (!started) await Bun.sleep(1);
    release({ ok: true, controls: { ok: true } });
    const rows = await shadowRows(task.id);
    expect(rows.map((row) => row.meta.decision)).toEqual(["would_skip"]);
  });

  test("a third concurrent run hits the concurrency cap", async () => {
    shadowEnv();
    const releases: Array<(value: unknown) => void> = [];
    const calls = stubDeps(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const tasks = [await workerTask(), await workerTask(), await workerTask()];
    for (const task of tasks) await finish(task);
    const allRows = async () =>
      (await Promise.all(tasks.map((task) => shadowRows(task.id)))).flat();
    while (releases.length < 2) await Bun.sleep(1);
    // Let the third hook run while the first two are still blocked.
    let rows = await getLogsByTaskIdAndEventType(tasks[2]!.id, "task_follow_up_gate_shadow");
    while (rows.length === 0) {
      await Bun.sleep(1);
      rows = await getLogsByTaskIdAndEventType(tasks[2]!.id, "task_follow_up_gate_shadow");
    }
    for (const release of releases) release({ ok: true, controls: { ok: true } });
    const all = await allRows();
    expect(all.map((row) => row.meta.decision).sort()).toEqual([
      "error",
      "would_skip",
      "would_skip",
    ]);
    expect(all.find((row) => row.meta.decision === "error")!.meta.reason).toBe("concurrency_cap");
    expect(calls.runVerifier).toBe(2);
  });

  test("a gated failed run records ineligible without running the verifier", async () => {
    shadowEnv();
    const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const task = await workerTask();
    const followUp = await createWorkerTaskFollowUp({ task, status: "failed", failureReason: "x" });
    expect(followUp).not.toBeNull();
    const rows = await shadowRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({
      decision: "ineligible",
      reason: "status_failed",
      status: "failed",
      followUpTaskId: followUp!.id,
      verdict: null,
      verifier: null,
    });
    expect(calls).toEqual({ getVerifier: 0, runVerifier: 0 });
  });

  test("a run with follow-up instructions records ineligible", async () => {
    shadowEnv();
    const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const task = await workerTask({ followUpConfig: { onCompleted: "post the report" } });
    await finish(task);
    const rows = await shadowRows(task.id);
    expect(rows.map((row) => row.meta.reason)).toEqual(["follow_up_instructions"]);
    expect(calls.runVerifier).toBe(0);
  });

  test("ungated and unscheduled runs write nothing", async () => {
    shadowEnv();
    const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const ungated = await workerTask({ scheduleId: NOT_GATED });
    const unscheduled = await workerTask({ scheduleId: undefined });
    await finish(ungated);
    await finish(unscheduled);
    expect(await shadowRows(ungated.id)).toHaveLength(0);
    expect(await shadowRows(unscheduled.id)).toHaveLength(0);
    expect(calls).toEqual({ getVerifier: 0, runVerifier: 0 });
  });

  test("no verifier configured records no_verifier", async () => {
    shadowEnv({ FOLLOW_UP_GATE_VERIFIER_SCRIPT: "" });
    const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const task = await workerTask();
    await finish(task);
    const rows = await shadowRows(task.id);
    expect(rows[0]!.meta).toMatchObject({ decision: "error", reason: "no_verifier" });
    expect(calls.getVerifier).toBe(0);
  });

  test("a missing verifier script records no_verifier", async () => {
    shadowEnv();
    setFollowUpGateDepsForTests({
      getVerifier: async () => null,
      runVerifier: async () => {
        throw new Error("must not run");
      },
    });
    const task = await workerTask();
    await finish(task);
    const rows = await shadowRows(task.id);
    expect(rows[0]!.meta).toMatchObject({
      decision: "error",
      reason: "no_verifier",
      verifier: null,
    });
  });

  describe("default verifier lookup and runner", () => {
    const runOutput = (overrides: Partial<RunScriptOutput>) => ({
      exitCode: 0,
      result: undefined as unknown,
      stdout: "",
      stderr: "",
      durationMs: 1,
      truncated: { stdout: false, stderr: false },
      ...overrides,
    });

    beforeAll(async () => {
      await upsertScriptByName({
        name: "gate-fixture",
        scope: "global",
        source: "export default () => ({ ok: true, controls: { ok: true } });",
        description: "Follow-up gate fixture",
        intent: "Exercise the default verifier path",
        signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
        typeChecked: true,
        embeddingMode: "skip",
      });
    });

    test("runs the global script as the Lead and records its version and hash", async () => {
      shadowEnv({ FOLLOW_UP_GATE_VERIFIER_SCRIPT: "gate-fixture" });
      const saved = spyOn(savedScriptRunner, "runSavedScriptAsAgent").mockResolvedValue(
        runOutput({ result: { ok: true, controls: { ok: true } } }),
      );
      try {
        const task = await workerTask();
        await finish(task);
        const rows = await shadowRows(task.id);
        expect(rows[0]!.meta.decision).toBe("would_skip");
        expect(rows[0]!.meta.verifier.name).toBe("gate-fixture");
        expect(rows[0]!.meta.verifier.version).toBeGreaterThanOrEqual(1);
        expect(rows[0]!.meta.verifier.contentHash).toMatch(/^[0-9a-f]{64}$/);
        const call = saved.mock.calls[0]![0];
        expect(call.agentId).toBe(leadId);
        expect(call.input).toEqual({ taskId: task.id });
        expect(call.timeoutMs).toBe(60_000);
      } finally {
        saved.mockRestore();
      }
    });

    test("a non-zero exit records verifier_error", async () => {
      shadowEnv({ FOLLOW_UP_GATE_VERIFIER_SCRIPT: "gate-fixture" });
      const saved = spyOn(savedScriptRunner, "runSavedScriptAsAgent").mockResolvedValue(
        runOutput({ exitCode: 1, error: "script failed" }),
      );
      try {
        const task = await workerTask();
        await finish(task);
        const rows = await shadowRows(task.id);
        expect(rows[0]!.meta).toMatchObject({
          decision: "error",
          reason: "verifier_error",
          error: "script failed",
        });
      } finally {
        saved.mockRestore();
      }
    });
  });
});

describe("follow-up gate enforce", () => {
  function enforceEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
    shadowEnv({
      FOLLOW_UP_GATE_MODE: "enforce",
      FOLLOW_UP_GATE_SCHEDULE_IDS: NOT_GATED,
      FOLLOW_UP_GATE_ENFORCE_SCHEDULE_IDS: GATED,
      ...overrides,
    });
  }

  async function followUpsOf(taskId: string) {
    await drainFollowUpGateShadowForTest();
    return getDbClient().query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
      [taskId],
    );
  }

  /** Finish an enforced run: no follow-up up front, then the gate decides after commit. */
  async function finishEnforced(task: AgentTask) {
    expect(
      await createWorkerTaskFollowUp({ task, status: "completed", output: "done" }),
    ).toBeNull();
    const followUps = await followUpsOf(task.id);
    const rows = await shadowRows(task.id);
    expect(rows).toHaveLength(1);
    return { followUps, meta: rows[0]!.meta };
  }

  test("enforce mode reads the enforce list; other modes ignore it", () => {
    const env = { FOLLOW_UP_GATE_ENFORCE_SCHEDULE_IDS: `${GATED}, not-a-uuid` };
    expect([
      ...readFollowUpGateConfig({ ...env, FOLLOW_UP_GATE_MODE: "enforce" }).enforceScheduleIds,
    ]).toEqual([GATED]);
    expect(
      readFollowUpGateConfig({ ...env, FOLLOW_UP_GATE_MODE: "shadow" }).enforceScheduleIds.size,
    ).toBe(0);
  });

  test("would_skip skips the follow-up and logs the decision", async () => {
    enforceEnv();
    const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const task = await workerTask();
    const { followUps, meta } = await finishEnforced(task);
    expect(followUps).toHaveLength(0);
    expect(meta).toMatchObject({
      mode: "enforce",
      decision: "would_skip",
      skipped: true,
      followUpTaskId: null,
      scheduleId: GATED,
      verifier: VERIFIER,
    });
    const suppressed = await getLogsByTaskIdAndEventType(task.id, "task_follow_up_suppressed");
    expect(suppressed.map((row) => JSON.parse(row.metadata ?? "{}"))).toEqual([
      { reason: "follow_up_gate", status: "completed" },
    ]);
    expect(calls.runVerifier).toBe(1);
  });

  test("would_keep creates the follow-up after the verifier", async () => {
    enforceEnv();
    stubDeps(async () => ({ ok: false, controls: { ok: true } }));
    const task = await workerTask();
    const { followUps, meta } = await finishEnforced(task);
    expect(followUps).toHaveLength(1);
    expect(meta).toMatchObject({
      mode: "enforce",
      decision: "would_keep",
      skipped: false,
      followUpTaskId: followUps[0]!.id,
    });
    expect((await getTaskById(followUps[0]!.id))?.agentId).toBe(leadId);
  });

  test("fail open: a verifier throw creates the follow-up", async () => {
    enforceEnv();
    stubDeps(async () => {
      throw new Error("boom");
    });
    const task = await workerTask();
    const { followUps, meta } = await finishEnforced(task);
    expect(followUps).toHaveLength(1);
    expect(meta).toMatchObject({
      decision: "error",
      reason: "verifier_error",
      skipped: false,
      followUpTaskId: followUps[0]!.id,
    });
  });

  test("fail open: a timeout creates the follow-up", async () => {
    enforceEnv();
    setFollowUpGateTimeoutMsForTests(20);
    stubDeps(() => new Promise(() => {}));
    const task = await workerTask();
    const { followUps, meta } = await finishEnforced(task);
    expect(followUps).toHaveLength(1);
    expect(meta).toMatchObject({ decision: "error", reason: "timeout", skipped: false });
  });

  test("fail open: an unset or missing verifier creates the follow-up", async () => {
    enforceEnv({ FOLLOW_UP_GATE_VERIFIER_SCRIPT: "" });
    stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const unset = await finishEnforced(await workerTask());
    expect(unset.followUps).toHaveLength(1);
    expect(unset.meta).toMatchObject({ decision: "error", reason: "no_verifier", skipped: false });

    enforceEnv();
    setFollowUpGateDepsForTests({
      getVerifier: async () => null,
      runVerifier: async () => {
        throw new Error("must not run");
      },
    });
    const missing = await finishEnforced(await workerTask());
    expect(missing.followUps).toHaveLength(1);
    expect(missing.meta).toMatchObject({ decision: "error", reason: "no_verifier" });
  });

  test("ineligible runs get their follow-up up front without the verifier", async () => {
    enforceEnv();
    const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const failed = await workerTask();
    const failedFollowUp = await createWorkerTaskFollowUp({
      task: failed,
      status: "failed",
      failureReason: "x",
    });
    expect(failedFollowUp).not.toBeNull();
    const instructed = await workerTask({ followUpConfig: { onCompleted: "post the report" } });
    await finish(instructed);
    expect((await shadowRows(failed.id))[0]!.meta).toMatchObject({
      mode: "enforce",
      decision: "ineligible",
      reason: "status_failed",
      skipped: false,
      followUpTaskId: failedFollowUp!.id,
    });
    expect((await shadowRows(instructed.id))[0]!.meta).toMatchObject({
      decision: "ineligible",
      reason: "follow_up_instructions",
    });
    expect(calls.runVerifier).toBe(0);
  });

  describe("a rejected chainedTaskId keeps the recovery follow-up", () => {
    const chainChild = (parentTaskId: string, creatorAgentId = workerId) =>
      createTaskExtended("chained work", {
        agentId: workerId,
        creatorAgentId,
        parentTaskId,
        followUpConfig: { disabled: true },
      });

    test.each([
      ["an unknown id", async () => crypto.randomUUID(), "no task has this id"],
      [
        "a terminal child",
        async (task: AgentTask) => {
          const child = await chainChild(task.id);
          await completeTask(child.id, "done");
          return child.id;
        },
        "it is completed, not live",
      ],
      [
        "a child of another task",
        async () => (await chainChild((await workerTask()).id)).id,
        "not this task",
      ],
      [
        "a child created by another agent",
        async (task: AgentTask) => (await chainChild(task.id, leadId)).id,
        "not created by the agent that completed this task",
      ],
    ] as const)("%s", async (_, chainedTaskIdFor, reason) => {
      for (const mode of ["enforce", "shadow"] as const) {
        enforceEnv(
          mode === "shadow"
            ? { FOLLOW_UP_GATE_MODE: "shadow", FOLLOW_UP_GATE_SCHEDULE_IDS: GATED }
            : {},
        );
        const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
        const task = await workerTask();
        const followUp = await createWorkerTaskFollowUp({
          task,
          status: "completed",
          output: "done",
          chainedTaskId: await chainedTaskIdFor(task),
          completingAgentId: workerId,
        });
        expect(followUp).not.toBeNull();
        const followUps = await getDbClient().query<{ id: string; task: string; agentId: string }>(
          "SELECT id, task, agentId FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
          [task.id],
        );
        expect(followUps).toHaveLength(1);
        expect(followUps[0]!.agentId).toBe(leadId);
        expect(followUps[0]!.task).toContain(reason);
        expect((await shadowRows(task.id))[0]!.meta).toMatchObject({
          mode,
          decision: "ineligible",
          reason: "chain_rejected",
          followUpTaskId: followUp!.id,
        });
        expect(calls.runVerifier).toBe(0);
      }
    });

    test("a live chained child still suppresses the follow-up and the gate", async () => {
      enforceEnv();
      const calls = stubDeps(async () => ({ ok: false, controls: { ok: true } }));
      const task = await workerTask();
      const child = await chainChild(task.id);
      expect(
        await createWorkerTaskFollowUp({
          task,
          status: "completed",
          output: "done",
          chainedTaskId: child.id,
          completingAgentId: workerId,
        }),
      ).toBeNull();
      expect(await followUpsOf(task.id)).toHaveLength(0);
      expect(await shadowRows(task.id)).toHaveLength(0);
      expect(calls.runVerifier).toBe(0);
    });
  });

  test("a shadow-listed schedule keeps shadow behaviour in enforce mode", async () => {
    enforceEnv();
    stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const task = await workerTask({ scheduleId: NOT_GATED });
    const followUp = await finish(task);
    const rows = await shadowRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({
      mode: "shadow",
      decision: "would_skip",
      followUpTaskId: followUp.id,
    });
    expect(rows[0]!.meta).not.toHaveProperty("skipped");
  });

  test("shadow mode ignores the enforce list", async () => {
    enforceEnv({ FOLLOW_UP_GATE_MODE: "shadow", FOLLOW_UP_GATE_SCHEDULE_IDS: "" });
    const calls = stubDeps(async () => ({ ok: true, controls: { ok: true } }));
    const task = await workerTask();
    await finish(task);
    expect(await shadowRows(task.id)).toHaveLength(0);
    expect(calls.runVerifier).toBe(0);
  });
});
