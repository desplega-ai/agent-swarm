import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getChildTasks,
  getDbClient,
  getTaskById,
  initDb,
  insertActiveSession,
  startTask,
} from "../be/db";
import type { InstallExtensionArgs as ExtensionInstallBody } from "../be/extensions/db";
import { installExtension, listExtensionRuns } from "../be/extensions/db";
import { validateBundle } from "../be/extensions/validate";
import { disableExtension, enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-heartbeat.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function enableBundle(bundle: ExtensionInstallBody) {
  const validation = await validateBundle(bundle);
  if (!validation.ok) throw new Error(validation.diagnostics.join("\n"));
  const installed = await installExtension(bundle);
  return await enableExtension(installed.extension.id);
}

async function createStalledTask(options: {
  minutes: number;
  tags?: string[];
  workflowStep?: boolean;
  session?: "fresh" | "stale";
  creatorAgentId?: string;
  taskType?: string;
}) {
  const agent = await createAgent({
    name: `heartbeat-worker-${crypto.randomUUID()}`,
    isLead: false,
    status: "busy",
  });
  const task = await createTaskExtended("Long-running heartbeat task", {
    agentId: agent.id,
    creatorAgentId: options.creatorAgentId,
    tags: options.tags,
    taskType: options.taskType,
  });
  await startTask(task.id);

  if (options.workflowStep) {
    await getDbClient().run("PRAGMA foreign_keys = OFF");
    try {
      await getDbClient().run("UPDATE agent_tasks SET workflowRunStepId = ? WHERE id = ?", [
        crypto.randomUUID(),
        task.id,
      ]);
    } finally {
      await getDbClient().run("PRAGMA foreign_keys = ON");
    }
  }

  if (options.session) {
    await insertActiveSession({
      agentId: agent.id,
      taskId: task.id,
      triggerType: "task_assigned",
    });
  }

  const staleAt = new Date(Date.now() - options.minutes * 60 * 1000).toISOString();
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
    staleAt,
    task.id,
  ]);
  if (options.session === "stale") {
    await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
      staleAt,
      task.id,
    ]);
  }

  return { agent, task };
}

describe("pre.heartbeat.remediate extensions", () => {
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

  beforeEach(async () => {
    await stopExtensionRuntime();
    const client = getDbClient();
    await client.run("DELETE FROM active_sessions");
    await client.run("DELETE FROM agent_tasks");
    await client.run("DELETE FROM extensions");
    await client.run("DELETE FROM agents");
  });

  test("keeps default no-session remediation when no extension is enabled", async () => {
    const { task } = await createStalledTask({ minutes: 10 });

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks).toHaveLength(1);
    expect(findings.autoResumedTasks[0]?.taskId).toBe(task.id);
    expect(findings.extensionSkipped).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("superseded");
  });

  test("changes a workflow-step fail proposal to record", async () => {
    const extension = await enableBundle(await loadBundleFixture("never-fail-long-tasks"));
    const { task } = await createStalledTask({ minutes: 10, workflowStep: true });

    const findings = await codeLevelTriage();

    expect(findings.stalledTasks.map((candidate) => candidate.id)).toContain(task.id);
    expect(findings.autoFailedTasks).toEqual([]);
    expect(findings.autoResumedTasks).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect(await listExtensionRuns(extension.id)).toMatchObject([
      { event: "pre.heartbeat.remediate", action: "modify" },
    ]);
  });

  test("escalates a Case A fail proposal to supersede-resume", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.manifest = { ...bundle.manifest, name: "resume-no-session-failures" };
    bundle.files["hooks.ts"] = `
import { modify, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.heartbeat.remediate", (event) => {
    if (event.classification === "no-session" && event.proposedAction === "fail") {
      return modify({ proposedAction: "supersede-resume" });
    }
  });
};
export default extension;
`;
    const extension = await enableBundle(bundle);
    const { task } = await createStalledTask({ minutes: 10, taskType: "reroute-decision" });

    const findings = await codeLevelTriage();

    expect(findings.autoFailedTasks).toEqual([]);
    expect(findings.autoResumedTasks[0]?.taskId).toBe(task.id);
    expect((await getTaskById(task.id))?.status).toBe("superseded");
    expect((await getChildTasks(task.id))[0]?.taskType).toBe("resume");
    expect(await listExtensionRuns(extension.id)).toMatchObject([
      { event: "pre.heartbeat.remediate", action: "modify" },
    ]);
  });

  test("blocks remediation for a configured task tag", async () => {
    const bundle = await loadBundleFixture("record-only-on-tag");
    const extension = await enableBundle({ ...bundle, config: { tag: "manual" } });
    const { task } = await createStalledTask({ minutes: 10, tags: ["manual"] });

    const findings = await codeLevelTriage();

    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect(findings.stalledTasks.map((candidate) => candidate.id)).toContain(task.id);
    expect(findings.extensionSkipped).toEqual([
      {
        taskId: task.id,
        extension: { id: extension.id, name: "record-only-on-tag" },
        reason: "Heartbeat remediation blocked for tag manual",
      },
    ]);

    await disableExtension(extension.id);
    const withoutExtension = await codeLevelTriage();
    expect(withoutExtension.autoResumedTasks[0]?.taskId).toBe(task.id);
    expect((await getTaskById(task.id))?.status).toBe("superseded");
  });

  test("provides stale-session details before remediation", async () => {
    const bundle = await loadBundleFixture("never-fail-long-tasks");
    bundle.manifest = { ...bundle.manifest, name: "record-stale-sessions" };
    bundle.files["hooks.ts"] = `
import { modify, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.heartbeat.remediate", (event) => {
    if (
      event.classification === "stale-session" &&
      event.session &&
      event.sessionHeartbeatAgeMs !== undefined &&
      event.reason.includes("heartbeat is stale")
    ) {
      return modify({ proposedAction: "record" });
    }
  });
};
export default extension;
`;
    await enableBundle(bundle);
    const { task } = await createStalledTask({ minutes: 20, session: "stale" });

    const findings = await codeLevelTriage();

    expect(findings.stalledTasks.map((candidate) => candidate.id)).toContain(task.id);
    expect(findings.autoResumedTasks).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("keeps the original action when an extension returns an invalid action", async () => {
    const bundle = await loadBundleFixture("never-fail-long-tasks");
    bundle.manifest = { ...bundle.manifest, name: "invalid-heartbeat-action" };
    bundle.files["hooks.ts"] = `
import { modify, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.heartbeat.remediate", () =>
    modify({ proposedAction: "invalid-action" as never }),
  );
};
export default extension;
`;
    await enableBundle(bundle);
    const { task } = await createStalledTask({ minutes: 10 });
    const warning = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const findings = await codeLevelTriage();
      expect(findings.autoResumedTasks[0]?.taskId).toBe(task.id);
      expect((await getTaskById(task.id))?.status).toBe("superseded");
      expect(warning).toHaveBeenCalledWith(
        "[Heartbeat] Extension returned an invalid remediation action:",
        "invalid-action",
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("can escalate a fresh-session stall to supersede and resume", async () => {
    const bundle = await loadBundleFixture("never-fail-long-tasks");
    bundle.manifest = { ...bundle.manifest, name: "resume-fresh-stalls" };
    bundle.files["hooks.ts"] = `
import { modify, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.heartbeat.remediate", (event) => {
    if (event.classification === "fresh-stalled") {
      return modify({ proposedAction: "supersede-resume" });
    }
  });
};
export default extension;
`;
    await enableBundle(bundle);
    const { task } = await createStalledTask({ minutes: 45, session: "fresh" });

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks[0]?.taskId).toBe(task.id);
    expect(findings.stalledTasks).toEqual([]);
    expect((await getTaskById(task.id))?.status).toBe("superseded");
    expect((await getChildTasks(task.id))[0]?.taskType).toBe("resume");
  });

  test("skips the extension that created the stalled task", async () => {
    const bundle = await loadBundleFixture("record-only-on-tag");
    bundle.manifest = { ...bundle.manifest, name: "skip-own-heartbeat" };
    const extension = await enableBundle({ ...bundle, config: { tag: "manual" } });
    const { task } = await createStalledTask({
      minutes: 10,
      tags: ["manual"],
      creatorAgentId: extension.agentId ?? undefined,
    });

    const findings = await codeLevelTriage();

    expect(findings.extensionSkipped).toEqual([]);
    expect(findings.autoResumedTasks[0]?.taskId).toBe(task.id);
    expect(await listExtensionRuns(extension.id)).toEqual([]);
  });
});
