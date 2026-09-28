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

/** No wake-up time in any form: `today at`, `tomorrow at`, `on 09-24 at`, `18:38`. */
function expectNoWakeTime(rendered: string | undefined) {
  expect(rendered).not.toContain("at the latest");
  expect(rendered).not.toMatch(/\b(?:today|tomorrow|on \S+) at\b/);
  expect(rendered).not.toMatch(/\d{1,2}:\d{2}/);
}

describe("Slack deferral output", () => {
  test("drops the wake-up time from an event-based card, keeping who it waits on", () => {
    const rendered = slackTaskOutput(task);
    expect(rendered).toBe("Waiting on Researcher");
    expectNoWakeTime(rendered);
    expect(
      slackTaskOutput({
        ...task,
        output: "Waiting on Researcher and Picateclas — or on 09-27 at 09:05 UTC at the latest",
      }),
    ).toBe("Waiting on Researcher and Picateclas");
    expect(
      slackTaskOutput({ ...task, output: "Waiting on 2 tasks — or today at 18:38 at the latest" }),
    ).toBe("Waiting on 2 tasks");
  });

  test("drops the wake-up time from a time-based card", () => {
    for (const output of [
      "Checking back today at 00:31",
      "Checking back tomorrow at 17:30",
      "Checking back on 09-27 at 09:05 UTC",
    ]) {
      const rendered = slackTaskOutput({ ...task, output });
      expect(rendered).toBe("Checking back later");
      expectNoWakeTime(rendered);
    }
  });

  test("rewrites a legacy notice without its ETA, the note, or the schedule link", () => {
    const rendered = slackTaskOutput(legacy);
    expect(rendered).toBe("Checking back later");
    expectNoWakeTime(rendered);
    expect(rendered).not.toContain("check the build");
    expect(rendered).not.toContain("schedules/12345678");
  });

  test("a legacy notice with no pending text still yields a card, not an empty one", () => {
    expect(
      slackTaskOutput({ ...legacy, output: legacy.output.replace("check the build", "") }),
    ).toBe("Checking back later");
  });

  test("an arrow inside a legacy note is still one legacy notice", () => {
    expect(slackTaskOutput({ ...legacy, output: `${legacy.output} (CI) -> deploy` })).toBe(
      "Checking back later",
    );
  });

  test("preserves final continuation results even with inherited deferred tags", () => {
    expect(slackTaskOutput({ ...task, output: "Build passed." })).toBe("Build passed.");
    // A result that merely starts like a card, or spans lines, is not a card.
    const result = "Checking back today at 18:38\n\nBuild passed at 18:40.";
    expect(slackTaskOutput({ ...task, output: result })).toBe(result);
    expect(slackTaskOutput({ ...task, output: "Waiting on CI to finish." })).toBe(
      "Waiting on CI to finish.",
    );
  });

  test("preserves schema output and non-deferral output verbatim", () => {
    expect(slackTaskOutput({ ...legacy, outputSchema: { type: "string" } })).toBe(legacy.output);
    expect(slackTaskOutput({ ...legacy, tags: [] })).toBe(legacy.output);
    expect(slackTaskOutput({ ...legacy, status: "in_progress" })).toBe(legacy.output);
    expect(slackTaskOutput({ ...task, tags: [] })).toBe(task.output);
    expect(slackTaskOutput({ ...task, output: undefined })).toBeUndefined();
  });
});
