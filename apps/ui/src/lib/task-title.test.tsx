import { describe, expect, test } from "bun:test";
import { taskListTitle } from "./task-title";

describe("taskListTitle", () => {
  test("prefers the explicit title", () => {
    expect(taskListTitle({ title: " Fix login ", task: "Repo: x. do it" })).toBe("Fix login");
  });

  test("strips a leading Repo: preamble and keeps the first line", () => {
    expect(
      taskListTitle({
        task: "Repo: https://github.com/desplega-ai/agent-swarm. Step 3 of the audit\nmore text",
      }),
    ).toBe("Step 3 of the audit");
    expect(taskListTitle({ task: "Repo: https://github.com/a/b\n\nShip the fix" })).toBe(
      "Ship the fix",
    );
  });

  test("falls back to the whole prompt when the preamble is all there is", () => {
    expect(taskListTitle({ task: "Repo: https://github.com/a/b" })).toBe(
      "Repo: https://github.com/a/b",
    );
  });

  test("skips a bare wrapper tag line", () => {
    expect(
      taskListTitle({ task: "<thread_context>\nPlease review PR 12\n</thread_context>" }),
    ).toBe("Please review PR 12");
  });

  test("leaves ordinary prompts alone", () => {
    expect(taskListTitle({ task: "Summarize the week" })).toBe("Summarize the week");
  });
});
