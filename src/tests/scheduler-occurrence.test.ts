import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import * as db from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import * as scheduleTask from "../scheduler/schedule-task";
import { executeSchedule, startScheduler, stopScheduler } from "../scheduler/scheduler";
import * as scripts from "../scripts-runtime/loader";
import { ExecutorRegistry } from "../workflows/executors/registry";

const dbPath = `./test-scheduler-occurrence-${crypto.randomUUID()}.sqlite`;
const createTask = scheduleTask.createStandaloneScheduleTask;
const scriptSuccess: scripts.RunScriptOutput = {
  result: undefined,
  stdout: "",
  stderr: "",
  exitCode: 0,
  durationMs: 0,
  truncated: { stdout: false, stderr: false },
};
let dispatch: ReturnType<typeof spyOn<typeof scheduleTask, "createStandaloneScheduleTask">>;
let scriptDispatch: ReturnType<typeof spyOn<typeof scripts, "runScript">>;
const templateGlobals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
let savedTemplate: Uint8Array | undefined;

beforeAll(async () => {
  // A real file lets an independent connection verify the claim is committed.
  savedTemplate = templateGlobals.__testMigrationTemplate;
  if (savedTemplate) await Bun.write(dbPath, savedTemplate);
  delete templateGlobals.__testMigrationTemplate;
  db.initDb(dbPath);
  setScriptEmbeddingProviderForTests({
    name: "test/noop",
    dimensions: 1,
    async embed() {
      return null;
    },
    async embedBatch(texts) {
      return texts.map(() => null);
    },
  });
  await upsertScriptByName({
    name: "scheduler-occurrence-fixture",
    scope: "global",
    source: "export default async () => null;",
    description: "Scheduler test fixture",
    intent: "test",
    signatureJson: "{}",
    agentId: "schedule",
    typeChecked: true,
  });
});
beforeEach(async () => {
  await db.getDbClient().run("DELETE FROM scheduled_tasks");
  dispatch = spyOn(scheduleTask, "createStandaloneScheduleTask");
  scriptDispatch = spyOn(scripts, "runScript").mockResolvedValue(scriptSuccess);
});
afterEach(() => {
  stopScheduler();
  dispatch.mockRestore();
  scriptDispatch.mockRestore();
});
afterAll(async () => {
  setScriptEmbeddingProviderForTests(null);
  db.closeDb();
  templateGlobals.__testMigrationTemplate = savedTemplate;
  for (const suffix of ["", "-wal", "-shm"]) await rm(dbPath + suffix, { force: true });
});

function dueSchedule(scheduleType: "recurring" | "one_time" = "recurring", script = false) {
  return db.createScheduledTask({
    name: crypto.randomUUID(),
    taskTemplate: "Run the scheduled task",
    intervalMs: 60_000,
    scheduleType,
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    ...(script
      ? ({ targetType: "script", scriptName: "scheduler-occurrence-fixture" } as const)
      : {}),
  });
}

async function tasksFor(scheduleId: string) {
  return db
    .getDbClient()
    .query<{ tags: string }>("SELECT tags FROM agent_tasks WHERE scheduleId = ?", [scheduleId]);
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for scheduler");
    await Bun.sleep(5);
  }
}

test.each([
  "recurring",
  "one_time",
] as const)("%s: concurrent recovery and polling dispatch exactly once after committing the claim", async (scheduleType) => {
  const schedule = await dueSchedule(scheduleType);
  dispatch.mockImplementation(async (snapshot, tags) => {
    const observer = new Database(dbPath, { readonly: true });
    try {
      const row = observer
        .query<{ nextRunAt: string | null; lastRunAt: string }, []>(
          "SELECT nextRunAt, lastRunAt FROM scheduled_tasks",
        )
        .get()!;
      expect(row.nextRunAt).not.toBe(schedule.nextRunAt);
      expect(row.lastRunAt).toBeTruthy();
    } finally {
      observer.close();
    }
    return createTask(snapshot, tags);
  });
  await Promise.all([executeSchedule(schedule, ["recovered"]), executeSchedule(schedule)]);
  await executeSchedule(schedule);
  expect(dispatch).toHaveBeenCalledTimes(1);
  const tasks = await tasksFor(schedule.id);
  expect(tasks).toHaveLength(1);
  expect(JSON.parse(tasks[0]!.tags)).toContain("recovered");
  const current = (await db.getScheduledTaskById(schedule.id))!;
  expect(current.enabled).toBe(scheduleType === "recurring");
  expect(current.nextRunAt).not.toBe(schedule.nextRunAt);
});

test("a rescheduled or disabled snapshot loses its claim", async () => {
  const schedule = await dueSchedule();
  await db.updateScheduledTask(schedule.id, {
    nextRunAt: new Date(Date.now() + 120_000).toISOString(),
  });
  await executeSchedule(schedule);
  const updated = (await db.getScheduledTaskById(schedule.id))!;
  await db.updateScheduledTask(schedule.id, { enabled: false });
  await executeSchedule(updated);
  expect(dispatch).not.toHaveBeenCalled();
});

test.each([
  "recurring",
  "one_time",
] as const)("%s: failure after an external side effect consumes the occurrence and records the error once", async (scheduleType) => {
  const schedule = await dueSchedule(scheduleType, true);
  let effects = 0;
  scriptDispatch.mockImplementation(async () => {
    effects++;
    throw new Error("target failed after its side effect");
  });
  await Promise.all([executeSchedule(schedule), executeSchedule(schedule, ["recovered"])]);
  await executeSchedule(schedule);
  expect(scriptDispatch).toHaveBeenCalledTimes(1);
  expect(effects).toBe(1);
  const current = (await db.getScheduledTaskById(schedule.id))!;
  expect(current.consecutiveErrors).toBe(1);
  expect(current.lastErrorMessage).toBe("target failed after its side effect");
  expect(current.lastErrorAt).toBeDefined();
  expect(current.lastRunAt).toBeDefined();
  expect(current.enabled).toBe(scheduleType === "recurring");
  if (scheduleType === "recurring") {
    expect(new Date(current.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 50_000);
  } else expect(current.nextRunAt).toBeUndefined();
});

test("successful recovery clears errors and repeated failures still auto-disable", async () => {
  const schedule = await dueSchedule();
  const failing = (await db.updateScheduledTask(schedule.id, {
    consecutiveErrors: 4,
    lastErrorAt: new Date().toISOString(),
    lastErrorMessage: "prior error",
  }))!;
  dispatch.mockRejectedValueOnce(new Error("fifth error"));
  await executeSchedule(failing, ["recovered"]);
  const disabled = (await db.getScheduledTaskById(schedule.id))!;
  expect(disabled.consecutiveErrors).toBe(5);
  expect(disabled.enabled).toBe(false);
  const reenabled = (await db.updateScheduledTask(schedule.id, {
    enabled: true,
    nextRunAt: schedule.nextRunAt,
  }))!;
  dispatch.mockImplementation(createTask);
  await executeSchedule(reenabled, ["recovered"]);
  const succeeded = (await db.getScheduledTaskById(schedule.id))!;
  expect(succeeded.consecutiveErrors).toBe(0);
  expect(succeeded.lastErrorAt).toBeUndefined();
  expect(succeeded.lastErrorMessage).toBeUndefined();
});

test("a slow failed dispatch cannot overwrite a newer occurrence", async () => {
  const schedule = await dueSchedule("recurring", true);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  scriptDispatch.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw new Error("old occurrence failed");
  });
  const first = executeSchedule(schedule);
  try {
    await started.promise;
    const next = (await db.getScheduledTaskById(schedule.id))!;
    await executeSchedule(next);
    const succeeded = await db.getScheduledTaskById(schedule.id);
    release.resolve();
    await first;
    expect(await db.getScheduledTaskById(schedule.id)).toEqual(succeeded);
  } finally {
    release.resolve();
    await first;
  }
});

test("startup waits for recovery before installing a poller, including repeated start calls", async () => {
  await dueSchedule("recurring", true);
  const release = Promise.withResolvers<void>();
  scriptDispatch.mockImplementation(async () => {
    await release.promise;
    return scriptSuccess;
  });
  const timers = spyOn(globalThis, "setInterval");
  const registry = new ExecutorRegistry();
  try {
    startScheduler(registry, 5);
    await waitUntil(() => scriptDispatch.mock.calls.length === 1);
    startScheduler(registry, 5);
    await Bun.sleep(25);
    expect(timers.mock.calls.filter((call) => call[1] === 5)).toHaveLength(0);
    release.resolve();
    await waitUntil(() => timers.mock.calls.some((call) => call[1] === 5));
    await Bun.sleep(25);
    expect(timers.mock.calls.filter((call) => call[1] === 5)).toHaveLength(1);
    expect(scriptDispatch).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    stopScheduler();
    timers.mockRestore();
  }
});

test("a rejected recovery still starts polling", async () => {
  await dueSchedule();
  const due = spyOn(db, "getDueScheduledTasks").mockRejectedValueOnce(
    new Error("recovery read failed"),
  );
  try {
    startScheduler(new ExecutorRegistry(), 5);
    await waitUntil(() => dispatch.mock.calls.length === 1 && due.mock.calls.length >= 3);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    stopScheduler();
    due.mockRestore();
  }
});

test("stopping during recovery prevents a late poller from being installed", async () => {
  await dueSchedule("recurring", true);
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  scriptDispatch.mockImplementation(async () => {
    await release.promise;
    finished.resolve();
    return scriptSuccess;
  });
  const timers = spyOn(globalThis, "setInterval");
  try {
    startScheduler(new ExecutorRegistry(), 5);
    await waitUntil(() => scriptDispatch.mock.calls.length === 1);
    stopScheduler();
    release.resolve();
    await finished.promise;
    await Bun.sleep(25);
    expect(timers.mock.calls.filter((call) => call[1] === 5)).toHaveLength(0);
  } finally {
    release.resolve();
    timers.mockRestore();
  }
});
