import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { installExtension } from "../be/extensions/db";
import { validateBundle } from "../be/extensions/validate";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-example-heartbeat-remediate.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

beforeAll(async () => {
  await removeDbFiles();
  closeDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  await stopExtensionRuntime();
  closeDb();
  await removeDbFiles();
});

test("never-fail-long-tasks records a stalled workflow task", async () => {
  const bundle = await loadBundleFixture("never-fail-long-tasks");
  const validation = await validateBundle(bundle);
  if (!validation.ok) throw new Error(validation.diagnostics.join("\n"));
  const installed = await installExtension(bundle);
  await enableExtension(installed.extension.id);

  const agent = await createAgent({ name: "example-worker", isLead: false, status: "busy" });
  const task = await createTaskExtended("Example long workflow task", { agentId: agent.id });
  await startTask(task.id);
  await getDbClient().run("PRAGMA foreign_keys = OFF");
  try {
    await getDbClient().run("UPDATE agent_tasks SET workflowRunStepId = ? WHERE id = ?", [
      crypto.randomUUID(),
      task.id,
    ]);
  } finally {
    await getDbClient().run("PRAGMA foreign_keys = ON");
  }
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
    staleAt,
    task.id,
  ]);

  const findings = await codeLevelTriage();

  expect(findings.stalledTasks.map((candidate) => candidate.id)).toContain(task.id);
  expect(findings.autoFailedTasks).toEqual([]);
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
});
