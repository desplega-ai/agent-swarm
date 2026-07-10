import { describe, expect, test } from "bun:test";
import {
  formatInlineCompletionOutputText,
  MAX_INLINE_OUTPUT_MESSAGE_LENGTH,
  shouldPostInlineCompletionOutput,
} from "../slack/responses";
import type { AgentTask, TaskAttachment } from "../types";

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

function attachment(overrides: Partial<TaskAttachment> = {}): TaskAttachment {
  return {
    id: crypto.randomUUID(),
    taskId: TASK_ID,
    agentId: null,
    name: "report",
    kind: "url",
    url: "https://example.com/report",
    isPrimary: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as TaskAttachment;
}

describe("Slack inline completion output", () => {
  test("posts only completed Slack tasks with substantive output and no primary artifact", () => {
    expect(shouldPostInlineCompletionOutput(task(), [])).toBe(true);
    expect(shouldPostInlineCompletionOutput(task(), [attachment()])).toBe(true);
    expect(shouldPostInlineCompletionOutput(task(), [attachment({ isPrimary: true })])).toBe(false);
    expect(shouldPostInlineCompletionOutput(task({ slackReplySent: true }), [])).toBe(false);
    expect(shouldPostInlineCompletionOutput(task({ output: "done" }), [])).toBe(false);
    expect(shouldPostInlineCompletionOutput(task({ slackChannelId: undefined }), [])).toBe(false);
    expect(shouldPostInlineCompletionOutput(task({ status: "failed" }), [])).toBe(false);
  });

  test("formats markdown output and keeps the Slack fallback text under 4000 chars", () => {
    const text = formatInlineCompletionOutputText({
      agentName: "Analyst",
      taskId: TASK_ID,
      output: `### Summary\n\n**Answer:** ${"This is a detailed prose finding. ".repeat(220)}`,
    });

    expect(text.length).toBeLessThanOrEqual(MAX_INLINE_OUTPUT_MESSAGE_LENGTH);
    expect(text).toContain("✅ *Analyst* completed with output");
    expect(text).toContain("*Summary*");
    expect(text).toContain("*Answer:*");
    expect(text).not.toContain("###");
    expect(text).not.toContain("**Answer:**");
    expect(text).toContain("…(full output in task");
    expect(text).toContain("|`abcdef12`>");
  });
});
