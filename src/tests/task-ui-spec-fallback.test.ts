import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { closeDb, createTaskExtended, initDb } from "../be/db";
import { upsertTaskUiSpec } from "../be/task-ui-spec";
import { withUiSpecFallback } from "../ui-spec/fallback";
import { validateTaskUiSpec } from "../ui-spec/validate";
import deploys from "./fixtures/ui-spec-slack/deploys.json";

const TEST_DB_PATH = "./test-task-ui-spec-fallback.sqlite";

async function taskWithSpec(): Promise<{ taskId: string; fallbackText: string }> {
  const task = await createTaskExtended("Weekly deploys", { source: "mcp" });
  const validated = validateTaskUiSpec(deploys.uiSpec, { taskId: task.id, actionsEnabled: false });
  if (!validated.ok) throw new Error(validated.issues.join("; "));
  await upsertTaskUiSpec(task.id, { spec: validated.spec, fallbackText: validated.fallbackText });
  return { taskId: task.id, fallbackText: validated.fallbackText };
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterEach(() => {
  delete process.env.UI_SPEC_ENABLED;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${TEST_DB_PATH}${suffix}`, { force: true });
});

describe("withUiSpecFallback", () => {
  test("legacy Slack card: the task response body ends with the card text", async () => {
    process.env.UI_SPEC_ENABLED = "true";
    const { taskId, fallbackText } = await taskWithSpec();
    const body = await withUiSpecFallback(taskId, "Deploys are up 12% this week.");
    expect(body).toBe(`Deploys are up 12% this week.\n\n${fallbackText}`);
    expect(fallbackText).toStartWith("*Weekly deploys*");
  });

  test("Slack Work Object: the result field ends with the card text", async () => {
    process.env.UI_SPEC_ENABLED = "true";
    const { taskId, fallbackText } = await taskWithSpec();
    expect(await withUiSpecFallback(taskId, "Done.")).toEndWith(`\n\n${fallbackText}`);
  });

  test("an empty body becomes the card text alone", async () => {
    process.env.UI_SPEC_ENABLED = "true";
    const { taskId, fallbackText } = await taskWithSpec();
    expect(await withUiSpecFallback(taskId, "")).toBe(fallbackText);
  });

  test("with no stored spec the body is returned unchanged", async () => {
    process.env.UI_SPEC_ENABLED = "true";
    const task = await createTaskExtended("No card", { source: "mcp" });
    const body = "Task completed.";
    expect(await withUiSpecFallback(task.id, body)).toBe(body);
  });

  test("with UI_SPEC_ENABLED off the body is returned unchanged", async () => {
    const { taskId } = await taskWithSpec();
    const body = "Deploys are up 12% this week.";
    expect(await withUiSpecFallback(taskId, body)).toBe(body);
  });
});
