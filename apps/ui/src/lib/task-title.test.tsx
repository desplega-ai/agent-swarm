import { describe, expect, test } from "bun:test";
import { taskListTitle, taskPromptPreview } from "./task-title";

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

describe("taskListTitle markdown marks", () => {
  test("takes off a heading mark and keeps an identifier's case", () => {
    expect(taskListTitle({ task: "## pr-ci-loop: fix CI on a/b#2591\nmore" })).toBe(
      "pr-ci-loop: fix CI on a/b#2591",
    );
  });

  test("takes off bold that wraps the whole line only", () => {
    expect(taskListTitle({ task: "**F5Bot daily alert snapshot**\nbody" })).toBe(
      "F5Bot daily alert snapshot",
    );
    expect(taskListTitle({ task: "**Fix** the login page" })).toBe("**Fix** the login page");
  });

  test("keeps an explicit title as written", () => {
    expect(taskListTitle({ title: "## Raw", task: "x" })).toBe("## Raw");
  });
});

describe("taskPromptPreview", () => {
  test("drops a heading title line", () => {
    expect(
      taskPromptPreview({ task: "## pr-fix-loop: re-review\nUse the code-quality skill." }),
    ).toBe("Use the code-quality skill.");
  });

  test("drops the line the title shows", () => {
    expect(taskPromptPreview({ task: "Fix the login page\nIt fails on Safari." })).toBe(
      "It fails on Safari.",
    );
  });

  test("drops a Repo: preamble with the title line", () => {
    expect(
      taskPromptPreview({ task: "Repo: https://github.com/a/b\n\nShip the fix\nThen tag it." }),
    ).toBe("Then tag it.");
    expect(taskPromptPreview({ task: "Repo: https://github.com/a/b. Ship it\nNow." })).toBe("Now.");
  });

  test("keeps the whole ask under an explicit title", () => {
    expect(taskPromptPreview({ title: "Login bug", task: "Fix the login page\nOn Safari." })).toBe(
      "Fix the login page\nOn Safari.",
    );
  });

  test("is empty when the title is the whole prompt", () => {
    expect(taskPromptPreview({ task: "Summarize the week" })).toBe("");
  });

  test("reads Slack tokens as names and leaves out the thread context", () => {
    const task =
      "<thread_context>\n<@U1|Ana>: it broke\n</thread_context>\n\n<@U1|Ana>: can <@U2|Bo> fix it?\nSee <https://x.dev/run/1|the run> in <#C1|ops>.";
    expect(taskPromptPreview({ task })).toBe("See the run in #ops.");
  });

  test("a list preview cut inside the thread context previews the thread", () => {
    // 300 characters and "…", as the list endpoint cuts a prompt.
    const head =
      "<thread_context>\n<@U08NR6QD6CS|Taras>: On the integration launch, here is <https://cal.example/x|our calendar>\n\nMight spin up your self-host this weekend ";
    const task = `${head.padEnd(300, "y")}…`;
    const preview = taskPromptPreview({ task });
    expect(taskListTitle({ task })).toBe("@Taras: On the integration launch, here is our calendar");
    expect(preview.startsWith("Might spin up your self-host this weekend")).toBe(true);
    expect(preview).not.toContain("<");
    expect(preview).not.toContain("thread_context");
  });

  test("later thread messages keep their speaker", () => {
    const head = "<thread_context>\n<@U1|Ana>: first message\n<@U2|Bo>: second message ";
    const task = `${head.padEnd(300, "z")}…`;
    expect(taskPromptPreview({ task }).startsWith("Bo: second message")).toBe(true);
  });
});
