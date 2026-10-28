import { describe, expect, mock, test } from "bun:test";
import { MAX_SECTION_LENGTH } from "../slack/blocks";
import {
  formatInlineCompletionOutputChunks,
  getAgentSlackIcon,
  sendWithPersona,
  shouldPostInlineCompletionOutput,
} from "../slack/responses";
import type { Agent, AgentTask } from "../types";

const TASK_ID = "abcdef12-3456-7890-abcd-ef1234567890";

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: TASK_ID,
    task: "Answer the question",
    status: "completed",
    output: "Here is the answer with enough substance to post inline.",
    slackChannelId: "C123",
    slackThreadTs: "1700000000.000001",
    slackReplySent: false,
    ...overrides,
  } as AgentTask;
}

describe("Slack inline completion output", () => {
  test("keeps the requested persona in DMs", async () => {
    const postMessage = mock(async () => ({ ts: "1" }));
    await sendWithPersona({ chat: { postMessage } } as never, {
      channel: "D123",
      thread_ts: "1",
      text: "done",
      username: "Literal Lead",
      icon: { icon_emoji: ":crown:" },
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ username: "Literal Lead", icon_emoji: ":crown:" }),
    );
  });

  test("posts each agent's Slack icon choice and nothing else", async () => {
    const cases: [Partial<Agent>, Record<string, string>][] = [
      [{ slackIcon: { type: "emoji", emoji: ":owl:" } }, { icon_emoji: ":owl:" }],
      [{ slackIcon: { type: "url", url: "https://a/o.png" } }, { icon_url: "https://a/o.png" }],
      [{ slackIcon: { type: "app" } }, {}],
      [{ isLead: true, slackIcon: null }, { icon_emoji: ":crown:" }],
      [{ slackIcon: null }, { icon_emoji: ":star:" }],
    ];
    for (const [overrides, icon] of cases) {
      const postMessage = mock(async (_payload: Record<string, unknown>) => ({ ts: "1" }));
      const agent = { id: "a1", name: "Owl Worker", isLead: false, ...overrides } as Agent;
      await sendWithPersona({ chat: { postMessage } } as never, {
        channel: "C123",
        thread_ts: "1",
        text: "done",
        username: "Owl Worker",
        icon: getAgentSlackIcon(agent),
      });
      const payload = postMessage.mock.calls[0]?.[0] ?? {};
      const sent = Object.fromEntries(
        Object.entries(payload).filter(([key]) => key.startsWith("icon_")),
      );
      expect(sent).toEqual(icon);
    }
  });

  test("posts only truncated completed Slack output that has not already been replied", () => {
    const longOutput = `Here is the answer. ${"Detailed finding ".repeat(20)}`;
    expect(shouldPostInlineCompletionOutput(task({ output: longOutput }))).toBe(true);
    expect(
      shouldPostInlineCompletionOutput(task({ output: longOutput, slackReplySent: true })),
    ).toBe(false);
    expect(shouldPostInlineCompletionOutput(task({ output: "Short answer" }))).toBe(false);
    expect(
      shouldPostInlineCompletionOutput(task({ output: longOutput, slackChannelId: undefined })),
    ).toBe(false);
    expect(shouldPostInlineCompletionOutput(task({ output: longOutput, status: "failed" }))).toBe(
      false,
    );
  });

  test("formats markdown and preserves the full output in Slack-safe section chunks", () => {
    const finalMarker = "FINAL-MARKER";
    const chunks = formatInlineCompletionOutputChunks({
      agentName: "Analyst",
      taskId: TASK_ID,
      output: `### Summary\n\n**Answer:** ${"This is a detailed prose finding. ".repeat(220)}${finalMarker}`,
    });
    const text = chunks.join("\n");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MAX_SECTION_LENGTH)).toBe(true);
    expect(text).toContain("✅ *Analyst* completed with output");
    expect(text).toContain("*Summary*");
    expect(text).toContain("*Answer:*");
    expect(text).not.toContain("###");
    expect(text).not.toContain("**Answer:**");
    expect(text).toContain("|`abcdef12`>");
    expect(text).toContain(finalMarker);
  });

  test("the inline output header uses SLACK_STATUS_ICON_COMPLETED", () => {
    process.env.SLACK_STATUS_ICON_COMPLETED = ":bee-lgtm:";
    try {
      const [first] = formatInlineCompletionOutputChunks({
        agentName: "Analyst",
        taskId: TASK_ID,
        output: "Done.",
      });
      expect(first?.startsWith(":bee-lgtm: *Analyst* completed with output")).toBe(true);
    } finally {
      delete process.env.SLACK_STATUS_ICON_COMPLETED;
    }
  });
});
