import { describe, expect, test } from "bun:test";
import { MAX_SECTION_LENGTH } from "../slack/blocks";
import {
  formatInlineCompletionOutputChunks,
  shouldPostInlineCompletionOutput,
} from "../slack/responses";
import type { AgentTask } from "../types";

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
});
