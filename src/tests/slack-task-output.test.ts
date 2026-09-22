import { describe, expect, test } from "bun:test";
import { slackTaskOutput } from "../slack/task-output";

/** The shape `defer-task` writes today: the human card, already rendered. */
const task = {
  status: "completed" as const,
  tags: ["deferred"],
  output: "Waiting on Researcher — or tomorrow at 17:30 at the latest",
};

/** The shape written before defer-task stored the card directly. */
const legacy = {
  ...task,
  output:
    "Deferred until tomorrow 17:30 UTC ([12345678](https://example.com/schedules/12345678)) -> check the build",
};

describe("Slack deferral output", () => {
  test("posts the stored deferral card verbatim", () => {
    expect(slackTaskOutput(task)).toBe(
      "Waiting on Researcher — or tomorrow at 17:30 at the latest",
    );
    expect(slackTaskOutput({ ...task, output: "Checking back today at 00:31" })).toBe(
      "Checking back today at 00:31",
    );
  });

  test("rewrites a legacy notice to its ETA, dropping the note and the schedule link", () => {
    const rendered = slackTaskOutput(legacy);
    expect(rendered).toBe("Checking back tomorrow 17:30 UTC");
    expect(rendered).not.toContain("check the build");
    expect(rendered).not.toContain("schedules/12345678");
  });

  test("a legacy notice with no pending text still yields its ETA, not an empty card", () => {
    expect(
      slackTaskOutput({ ...legacy, output: legacy.output.replace("check the build", "") }),
    ).toBe("Checking back tomorrow 17:30 UTC");
  });

  test("an arrow inside a legacy note does not extend the ETA", () => {
    expect(slackTaskOutput({ ...legacy, output: `${legacy.output} (CI) -> deploy` })).toBe(
      "Checking back tomorrow 17:30 UTC",
    );
  });

  test("preserves final continuation results even with inherited deferred tags", () => {
    expect(slackTaskOutput({ ...task, output: "Build passed." })).toBe("Build passed.");
  });

  test("preserves schema output and non-deferral output verbatim", () => {
    expect(slackTaskOutput({ ...legacy, outputSchema: { type: "string" } })).toBe(legacy.output);
    expect(slackTaskOutput({ ...legacy, tags: [] })).toBe(legacy.output);
    expect(slackTaskOutput({ ...legacy, status: "in_progress" })).toBe(legacy.output);
    expect(slackTaskOutput({ ...task, output: undefined })).toBeUndefined();
  });
});
