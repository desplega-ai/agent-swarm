import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getTaskById,
  initDb,
  updateTaskTitle,
} from "../be/db";
import { setTaskTitleIfUnset } from "../be/db/tasks/write";
import {
  isTaskAutoTitleEnabled,
  startTaskAutoTitleListener,
  type TaskAutoTitleListener,
} from "../be/task-auto-title-listener";
import type { generateTaskTitle } from "../utils/internal-ai/task-title";
import { workflowEventBus } from "../workflows/event-bus";

const TEST_DB_PATH = "./test-task-auto-title-listener.sqlite";

/**
 * `createTaskExtended` emits `task.created` from an after-commit hook that
 * imports the event bus asynchronously, so the event lands after the call
 * returns. Create the task through this helper to await that emission.
 */
async function createTaskAndAwaitEvent(task: string): Promise<string> {
  const created = new Promise<void>((resolve) => {
    const handler = () => {
      workflowEventBus.off("task.created", handler);
      resolve();
    };
    workflowEventBus.on("task.created", handler);
  });
  const row = await createTaskExtended(task, { agentId, source: "api" });
  await created;
  return row.id;
}
const LONG_TASK =
  "Investigate why the nightly Playwright suite times out on the sessions page after the sidebar redesign and fix the flake.";

let agentId: string;
let listener: TaskAutoTitleListener | null = null;

type Generate = typeof generateTaskTitle;

/** Generator stub that returns `title` and records every prompt it saw. */
function generator(title: string | null, seen: string[] = []) {
  const generate: Generate = async (opts) => {
    seen.push(opts.task);
    return title
      ? { ok: true, title, model: "test/model", kind: "openrouter" }
      : { ok: false, reason: "all-models-failed" };
  };
  return { generate, seen };
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "auto-title-worker", isLead: false, status: "idle" })).id;
});

afterEach(() => {
  listener?.stop();
  listener = null;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("isTaskAutoTitleEnabled", () => {
  test("defaults on and honours false-ish values", () => {
    expect(isTaskAutoTitleEnabled({})).toBe(true);
    expect(isTaskAutoTitleEnabled({ TASK_AUTO_TITLE_ENABLED: "" })).toBe(true);
    expect(isTaskAutoTitleEnabled({ TASK_AUTO_TITLE_ENABLED: "false" })).toBe(false);
    expect(isTaskAutoTitleEnabled({ TASK_AUTO_TITLE_ENABLED: "0" })).toBe(false);
    expect(isTaskAutoTitleEnabled({ TASK_AUTO_TITLE_ENABLED: "true" })).toBe(true);
  });
});

describe("setTaskTitleIfUnset", () => {
  test("writes once and never replaces an existing title", async () => {
    const task = await createTaskExtended(LONG_TASK, { agentId, source: "api" });
    expect(task.title).toBeUndefined();

    const first = await setTaskTitleIfUnset(task.id, "  Generated title  ");
    expect(first?.title).toBe("Generated title");

    const second = await setTaskTitleIfUnset(task.id, "Another title");
    expect(second).toBeNull();
    expect((await getTaskById(task.id))?.title).toBe("Generated title");

    expect(await setTaskTitleIfUnset(task.id, "   ")).toBeNull();
  });
});

describe("startTaskAutoTitleListener", () => {
  test("titles a new task after commit", async () => {
    const { generate, seen } = generator("Fix sessions page Playwright flake");
    listener = startTaskAutoTitleListener({ env: {}, generate });

    const taskId = await createTaskAndAwaitEvent(LONG_TASK);
    await listener.idle();

    expect(seen).toEqual([LONG_TASK]);
    expect((await getTaskById(taskId))?.title).toBe("Fix sessions page Playwright flake");
  });

  test("keeps a title a person set while the model was running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate: Generate = async () => {
      await gate;
      return { ok: true, title: "Model title", model: "test/model", kind: "openrouter" };
    };
    listener = startTaskAutoTitleListener({ env: {}, generate });

    const taskId = await createTaskAndAwaitEvent(LONG_TASK);
    await updateTaskTitle(taskId, "Human title");
    release();
    await listener.idle();

    expect((await getTaskById(taskId))?.title).toBe("Human title");
  });

  test("leaves the task untouched when generation fails", async () => {
    const { generate, seen } = generator(null);
    listener = startTaskAutoTitleListener({ env: {}, generate });

    const taskId = await createTaskAndAwaitEvent(LONG_TASK);
    await listener.idle();

    expect(seen.length).toBe(1);
    expect((await getTaskById(taskId))?.title).toBeUndefined();
  });

  test("does nothing when TASK_AUTO_TITLE_ENABLED is false", async () => {
    const { generate, seen } = generator("Should not land");
    listener = startTaskAutoTitleListener({ env: { TASK_AUTO_TITLE_ENABLED: "false" }, generate });

    const taskId = await createTaskAndAwaitEvent(LONG_TASK);
    await listener.idle();

    expect(seen).toEqual([]);
    expect((await getTaskById(taskId))?.title).toBeUndefined();
  });

  test("stop() detaches from the event bus", async () => {
    const { generate, seen } = generator("Late title");
    const handle = startTaskAutoTitleListener({ env: {}, generate });
    handle.stop();

    await createTaskAndAwaitEvent(LONG_TASK);
    await handle.idle();
    expect(seen).toEqual([]);
  });
});
