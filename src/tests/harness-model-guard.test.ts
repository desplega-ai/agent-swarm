// Harness model guard: a task model from another harness family never reaches a CLI.
// Covers the heartbeat pool auto-assign filter and the worker-side spawn guard.
// Create-time and claim-time checks live in explicit-model-validation.test.ts and
// model-tier-resolution.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { guardSpawnModel } from "../utils/spawn-model-guard";
import "../tools/templates";

const TEST_DB_PATH = "./test-harness-model-guard.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => undefined);
  }
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  closeDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM agents");
});

describe("autoAssignPoolTasks harness filter", () => {
  test("a claude-opus-5-5 pool task goes to the idle Claude worker, not the idle Codex worker", async () => {
    // The Codex worker sorts first, so a missing filter would pick it.
    const codex = await createAgent({
      name: "aaa-idle-codex",
      isLead: false,
      status: "idle",
      harnessProvider: "codex",
    });
    const claude = await createAgent({
      name: "zzz-idle-claude",
      isLead: false,
      status: "idle",
      harnessProvider: "claude",
    });
    const task = await createTaskExtended("pool work", { model: "claude-opus-5-5" });

    const findings = await codeLevelTriage();

    expect(findings.autoAssigned).toEqual([{ taskId: task.id, agentId: claude.id }]);
    expect((await getTaskById(task.id))?.agentId).not.toBe(codex.id);
  });

  test("with only an idle Codex worker the task stays queued", async () => {
    await createAgent({
      name: "only-codex",
      isLead: false,
      status: "idle",
      harnessProvider: "codex",
    });
    const task = await createTaskExtended("pool work", { model: "claude-opus-5-5" });

    const findings = await codeLevelTriage();

    expect(findings.autoAssigned).toHaveLength(0);
    expect((await getTaskById(task.id))?.status).toBe("unassigned");
  });
});

describe("guardSpawnModel (worker spawn)", () => {
  test("a MODEL_OVERRIDE from another harness family falls back to the adapter default with a warning", () => {
    const decision = guardSpawnModel({
      taskModel: "",
      configModel: "gpt-6-luna",
      harness: "claude",
      role: "worker",
    });
    expect(decision).toEqual({
      kind: "ok",
      model: "",
      warning:
        "[worker] MODEL_OVERRIDE gpt-6-luna does not run on the claude harness; using the adapter default",
    });
  });

  test("a compatible MODEL_OVERRIDE, a shortname, and an unpinned harness pass through", () => {
    expect(
      guardSpawnModel({ taskModel: "", configModel: "gpt-6-luna", harness: "codex", role: "w" }),
    ).toEqual({ kind: "ok", model: "gpt-6-luna" });
    expect(
      guardSpawnModel({ taskModel: "", configModel: "opus", harness: "codex", role: "w" }),
    ).toEqual({ kind: "ok", model: "opus" });
    expect(
      guardSpawnModel({ taskModel: "claude-opus-5-5", configModel: "", harness: "pi", role: "w" }),
    ).toEqual({ kind: "ok", model: "claude-opus-5-5" });
  });

  test("a task model from another harness family is a mismatch, so the runner never spawns", () => {
    const decision = guardSpawnModel({
      taskModel: "claude-opus-5-5",
      configModel: "gpt-6-luna",
      harness: "codex",
      role: "worker",
    });
    expect(decision.kind).toBe("mismatch");
    expect(decision.kind === "mismatch" && decision.reason).toBe(
      '[model-harness-mismatch] Model "claude-opus-5-5" does not run on the codex harness of this worker. The task pinned a model from another harness family. Re-create the task with modelTier or with a codex model.',
    );
  });
});
