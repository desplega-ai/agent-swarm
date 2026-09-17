import { describe, expect, test } from "bun:test";
import { slackTaskOutput } from "../slack/task-output";

const task = {
  status: "completed" as const,
  tags: ["deferred"],
  output:
    "Deferred until tomorrow 17:30 UTC ([12345678](https://example.com/schedules/12345678)) -> check the build",
};

describe("Slack deferral output", () => {
  test("keeps the pending work without the ETA or schedule link", () => {
    expect(slackTaskOutput(task)).toBe("Pending: check the build");
    expect(task.output).toContain("tomorrow 17:30 UTC");
  });

  test("removes an ETA-only line and preserves punctuation in the pending description", () => {
    expect(slackTaskOutput({ ...task, output: task.output.replace("check the build", "") })).toBe(
      "",
    );
    expect(slackTaskOutput({ ...task, output: `${task.output} (CI) -> deploy` })).toBe(
      "Pending: check the build (CI) -> deploy",
    );
  });

  test("preserves final continuation results even with inherited deferred tags", () => {
    expect(slackTaskOutput({ ...task, output: "Build passed." })).toBe("Build passed.");
  });

  test("preserves schema output and non-deferral output verbatim", () => {
    expect(slackTaskOutput({ ...task, outputSchema: { type: "string" } })).toBe(task.output);
    expect(slackTaskOutput({ ...task, tags: [] })).toBe(task.output);
    expect(slackTaskOutput({ ...task, status: "in_progress" })).toBe(task.output);
    expect(slackTaskOutput({ ...task, output: undefined })).toBeUndefined();
  });
});
