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

  test("a Slack prompt reads as the question, with no mention tokens", () => {
    const task = `<@U08NR6QD6CS|Taras>: <@U0A3YMSRKJB> (that's you) what are the events we support via the extensions of the swarm?

<thread_context>
Thread in #swarm-dev (3 earlier messages)
- Taras: we should make the extension system the default way to hook into the swarm
</thread_context>

Reply in the thread.`;
    expect(taskListTitle({ task })).toBe(
      "What are the events we support via the extensions of the swarm?",
    );
  });

  test("a thread block before the message is skipped", () => {
    expect(
      taskListTitle({
        task: "<thread_context>\n<@U1|Ana>: it broke\n</thread_context>\n\n<@U1|Ana>: can <@U2|Bo> fix <#C1|ops>?",
      }),
    ).toBe("Can @Bo fix #ops?");
  });

  test("an unknown mention reads as @someone", () => {
    expect(taskListTitle({ task: "<@U9> (unknown user) asked for a summary" })).toBe(
      "@someone asked for a summary",
    );
  });

  test("capitalizes a plain first word only", () => {
    expect(taskListTitle({ task: "fix the login page" })).toBe("Fix the login page");
    expect(taskListTitle({ task: "https://example.com/x is down" })).toBe(
      "https://example.com/x is down",
    );
    expect(taskListTitle({ task: "taskListTitle drops tags" })).toBe("taskListTitle drops tags");
    expect(taskListTitle({ task: "src/lib is untested" })).toBe("src/lib is untested");
  });
});
