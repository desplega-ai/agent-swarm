// What a task records about the model and effort it ran on, and what a re-run
// of the same row carries over. Regression for: an agent's model/effort changed
// in the dashboard, and the next run of a task kept the previous values.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getTaskById,
  initDb,
  updateTaskClaudeSessionId,
} from "../be/db";
import { effectiveReasoningEffort } from "../providers/reasoning-effort";
import { resumedTaskModelSelection, taskModelPin } from "../tasks/model-pin";

const TEST_DB_PATH = "./test-task-model-effort-rerun.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("taskModelPin", () => {
  test("a model reported by a previous session is not a pin", () => {
    expect(taskModelPin({ model: "claude-opus-5-5", claudeSessionId: "s1" })).toBeUndefined();
  });

  test("a model a tier layer chose is not a pin", () => {
    expect(
      taskModelPin({
        model: "claude-opus-5-5",
        modelTier: "smart",
        resolvedModel: "claude-opus-5-5",
        modelSource: "tier-default",
      }),
    ).toBeUndefined();
  });

  test("the creator's model on an unclaimed row is the pin", () => {
    expect(taskModelPin({ model: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
  });

  test("a claimed pin keeps its alias", () => {
    expect(
      taskModelPin({
        model: "claude-opus-5-5",
        modelSource: "model",
        modelAlias: "latest:anthropic/opus",
        claudeSessionId: "s1",
      }),
    ).toBe("latest:anthropic/opus");
  });
});

describe("resumedTaskModelSelection", () => {
  test("a paused unpinned task resumes without the previous run's model or claim record", () => {
    expect(
      resumedTaskModelSelection({
        model: "claude-opus-5-5",
        resolvedModel: "claude-opus-5-5",
        modelSource: "tier-config",
        modelTier: "smart",
        claudeSessionId: "s1",
      }),
    ).toEqual({ model: undefined, resolvedModel: undefined, modelSource: undefined });
  });

  test("a paused pinned task resumes on its pin", () => {
    expect(
      resumedTaskModelSelection({
        model: "claude-sonnet-5-5",
        resolvedModel: "claude-sonnet-5-5",
        modelSource: "model",
        claudeSessionId: "s1",
      }),
    ).toEqual({
      model: "claude-sonnet-5-5",
      resolvedModel: "claude-sonnet-5-5",
      modelSource: "model",
    });
  });
});

describe("effectiveReasoningEffort", () => {
  test("unset effort records nothing", () => {
    expect(effectiveReasoningEffort("claude", "claude-opus-5-5", undefined)).toBeNull();
  });

  test("harnesses without effort support record nothing", () => {
    expect(effectiveReasoningEffort("devin", "", "high")).toBeNull();
  });

  test("a level the model cannot take is dropped, the same as the adapter does", () => {
    expect(effectiveReasoningEffort("claude", "not-a-reasoning-model", "high")).toBeNull();
  });
});

describe("session report records the effort", () => {
  test("the effort the session ran at lands on resolvedEffort, and a re-run replaces it", async () => {
    const agent = await createAgent({ name: "effort-rerun", isLead: false, status: "idle" });
    const task = await createTaskExtended("work", { agentId: agent.id });

    // First run: the agent's REASONING_EFFORT_OVERRIDE was high.
    await updateTaskClaudeSessionId(
      task.id,
      "run-1",
      "claude",
      undefined,
      "claude-opus-5-5",
      undefined,
      undefined,
      "high",
    );
    let row = await getTaskById(task.id);
    expect(row?.resolvedEffort).toBe("high");
    // The requested-effort column stays the creator's value, not a pin.
    expect(row?.effort).toBeUndefined();

    // Effort changed to low in the dashboard; the next run records low.
    await updateTaskClaudeSessionId(
      task.id,
      "run-2",
      "claude",
      undefined,
      "claude-opus-5-5",
      undefined,
      undefined,
      "low",
    );
    row = await getTaskById(task.id);
    expect(row?.resolvedEffort).toBe("low");

    // Effort set back to Auto: the harness default applied, nothing to show.
    await updateTaskClaudeSessionId(
      task.id,
      "run-3",
      "claude",
      undefined,
      "claude-opus-5-5",
      undefined,
      undefined,
      null,
    );
    row = await getTaskById(task.id);
    expect(row?.resolvedEffort).toBeUndefined();
  });
});
