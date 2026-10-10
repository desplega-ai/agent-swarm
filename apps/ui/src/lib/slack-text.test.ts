import { describe, expect, test } from "bun:test";
import { formatSlackMentions, parseSlackPrompt } from "./slack-text";

// The completed task on the QA stack mirrors a production Slack task.
const PROD_PROMPT = `<@U08NR6QD6CS|Taras>: <@U0A3YMSRKJB> (that's you) what are the events we support via the extensions of the swarm?

<thread_context>
Thread in #swarm-dev (3 earlier messages)
- Taras: we should make the extension system the default way to hook into the swarm
- Lead: agreed, the contract lives in src/extensions/contract.ts
- Taras: ok so which ones can I subscribe to today?
</thread_context>

Reply in the thread. Keep it short and link the doc if one exists.`;

describe("formatSlackMentions", () => {
  test("a resolved mention becomes @Name", () => {
    expect(formatSlackMentions("ping <@U08NR6QD6CS|Taras> about it")).toBe("ping @Taras about it");
  });

  test("the swarm's own bot mention is removed", () => {
    expect(formatSlackMentions("<@U0A3YMSRKJB> (that's you) what changed?")).toBe("what changed?");
    expect(formatSlackMentions("hey <@U0A3YMSRKJB> (that's you) what changed?")).toBe(
      "hey what changed?",
    );
  });

  test("an unknown user and a bare mention become @someone", () => {
    expect(formatSlackMentions("ask <@U999> (unknown user) first")).toBe("ask @someone first");
    expect(formatSlackMentions("ask <@U999> first")).toBe("ask @someone first");
  });

  test("a channel link becomes #name", () => {
    expect(formatSlackMentions("see <#C0AR967K0KZ|swarm-dev>")).toBe("see #swarm-dev");
    expect(formatSlackMentions("see <#C0AR967K0KZ>")).toBe("see #channel");
  });

  test("a labeled URL becomes its label, a bare URL its address", () => {
    expect(formatSlackMentions("read <https://docs.agent-swarm.dev/x|the docs> now")).toBe(
      "read the docs now",
    );
    expect(formatSlackMentions("read <https://docs.agent-swarm.dev/x>")).toBe(
      "read https://docs.agent-swarm.dev/x",
    );
  });

  test("special and group mentions read as handles", () => {
    expect(formatSlackMentions("<!here> and <!subteam^S123|@oncall>")).toBe("@here and @oncall");
  });

  test("text with no Slack tokens is returned unchanged", () => {
    const plain = "Review <thread_context> handling in `a < b > c` and <div>tags</div>.";
    expect(formatSlackMentions(plain)).toBe(plain);
  });
});

describe("parseSlackPrompt", () => {
  test("the production shape: speaker, ask, and quoted thread", () => {
    const parsed = parseSlackPrompt(PROD_PROMPT);
    expect(parsed.speaker).toBe("Taras");
    expect(parsed.ask).toBe(
      "<@U0A3YMSRKJB> (that's you) what are the events we support via the extensions of the swarm?\n\nReply in the thread. Keep it short and link the doc if one exists.",
    );
    expect(parsed.thread).toEqual([
      {
        speaker: "Taras",
        text: "we should make the extension system the default way to hook into the swarm",
      },
      { speaker: "Lead", text: "agreed, the contract lives in src/extensions/contract.ts" },
      { speaker: "Taras", text: "ok so which ones can I subscribe to today?" },
    ]);
  });

  test("the context block before the message, as the Slack handlers write it", () => {
    const parsed = parseSlackPrompt(
      [
        "<thread_context>",
        "<@U1|Ana>: the deploy failed again",
        "  stack trace attached",
        "- step: rerun it",
        "[Agent]: I will look",
        "<@U2> (unknown user): any news?",
        "</thread_context>",
        "",
        "<@U1|Ana>: why did it fail?",
      ].join("\n"),
    );
    expect(parsed.speaker).toBe("Ana");
    expect(parsed.ask).toBe("why did it fail?");
    expect(parsed.thread).toEqual([
      { speaker: "Ana", text: "the deploy failed again\n  stack trace attached\n- step: rerun it" },
      { speaker: "Agent", text: "I will look" },
      { speaker: undefined, text: "any news?" },
    ]);
  });

  test("an unknown asker has no speaker, and the prefix is still removed", () => {
    const parsed = parseSlackPrompt("<@U999> (unknown user): can you check the build?");
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.ask).toBe("can you check the build?");
  });

  test("a prompt that is not from Slack is returned as the ask", () => {
    expect(parseSlackPrompt("  Summarize the week\nwith links  ")).toEqual({
      ask: "Summarize the week\nwith links",
      speaker: undefined,
      thread: [],
    });
  });
});
