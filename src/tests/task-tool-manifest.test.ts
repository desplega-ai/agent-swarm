import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";
import { parseTaskToolManifest, selectTaskTools } from "../utils/task-tool-manifest";

const scheduleId = "12345678-1234-4234-8234-123456789abc";

describe("task tool manifests", () => {
  test("matches exact keys and lets an empty schedule opt out of its type", () => {
    const manifest = parseTaskToolManifest(
      JSON.stringify({
        taskTypes: { review: ["script-run", "script-run", "get-tasks"] },
        schedules: { [scheduleId]: [] },
      }),
    );
    expect(selectTaskTools(manifest, { taskType: "review" })).toEqual(["script-run", "get-tasks"]);
    expect(selectTaskTools(manifest, { taskType: "review", scheduleId })).toEqual([]);
    expect(selectTaskTools(manifest, { taskType: "review-follow-up" })).toEqual([]);
    expect(selectTaskTools(manifest, { taskType: "toString" })).toEqual([]);
  });

  test("Slack tools only preload for a task carrying Slack context", () => {
    const manifest = parseTaskToolManifest('{"taskTypes":{"review":["slack-read","script-run"]}}');
    expect(selectTaskTools(manifest, { taskType: "review" })).toEqual(["script-run"]);
    expect(selectTaskTools(manifest, { taskType: "review", slackChannelId: "C123" })).toEqual([
      "slack-read",
      "script-run",
    ]);
  });

  test("config writes reject unknown tools, invalid shapes, and oversized selections", () => {
    for (const value of [
      "not json",
      "null",
      "[]",
      '{"taskTypes":{"review":["not-a-tool"]}}',
      '{"taskTypes":{"review":"script-run"}}',
      '{"schedules":{"not-a-uuid":["script-run"]}}',
      '{"taskType":{"review":["script-run"]}}',
      JSON.stringify({ taskTypes: { review: Array(17).fill("script-run") } }),
    ]) {
      expect(validateConfigValue("TASK_TOOL_MANIFESTS", value)).toContain("Invalid");
    }
    expect(validateConfigValue("TASK_TOOL_MANIFESTS", "{}")).toBeNull();
    expect(validateConfigValue("TASK_TOOL_PRELOAD_ENABLED", "false")).toBeNull();
    expect(validateConfigValue("TASK_TOOL_PRELOAD_ENABLED", "treu")).toContain("Invalid");
  });
});
