import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  initDb,
  startTask,
} from "../be/db";
import { installExtension } from "../be/extensions/db";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-example-rewrite-and-suppress.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function enableFixture(name: string): Promise<void> {
  const installed = await installExtension(await loadBundleFixture(name));
  await enableExtension(installed.extension.id);
}

describe("extension examples: rewrite and suppress", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    await stopExtensionRuntime();
    closeDb();
    await removeDbFiles();
  });

  test("rewrites task priority and suppresses Slack lead follow-ups", async () => {
    await enableFixture("rewrite-task-priority");
    await enableFixture("suppress-lead-follow-up");

    const rewritten = await createTaskWithSiblingAwareness("Prioritize this task", {
      source: "api",
      priority: 50,
    });
    expect(rewritten.priority).toBe(1);

    await createAgent({ name: "example-lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "example-worker", isLead: false, status: "idle" });
    const slackTask = await createTaskExtended("Slack task", {
      agentId: worker.id,
      source: "slack",
    });
    await startTask(slackTask.id);
    const completed = await completeTask(slackTask.id, "done");

    expect(
      await createWorkerTaskFollowUp({
        task: completed!,
        status: "completed",
        output: "done",
      }),
    ).toBeNull();
  });
});
