import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { SummaryWithRatingsSchema } from "../../be/memory/raters/llm.js";
import { summarizeSession } from "../../utils/internal-ai/summarize-session.js";

const LONG_TRANSCRIPT = `User: please refactor X
Assistant: I'll start with reading the file.
Tool[Read]: input={"file":"/tmp/x"} output="ok"
Assistant: Now I'll make the change.
Tool[Edit]: input={"file":"/tmp/x","old":"a","new":"b"} output="ok"
Assistant: Done.`.padEnd(200, "x");

describe("summarizeSession", () => {
  test("pass-through: injected _completeStructured result is returned verbatim", async () => {
    const fake: z.infer<typeof SummaryWithRatingsSchema> = {
      summary: "Learned: X uses Y",
      ratings: [{ id: "mem-1", score: 0.9, reasoning: "very useful" }],
    };
    const result = await summarizeSession({
      harness: "pi",
      transcript: LONG_TRANSCRIPT,
      retrievals: [{ id: "mem-1", name: "x", content: "y" }],
      taskContext: { sourceTaskId: "task-1", agentId: "agent-1" },
      apiUrl: "http://localhost:3013",
      apiKey: "k",
      _completeStructured: (async () => fake) as any,
    });
    expect(result).toEqual(fake);
  });

  test("retrievals are injected into the userPrompt via buildSummaryWithRatingsPrompt", async () => {
    let capturedUserPrompt = "";
    await summarizeSession({
      harness: "claude",
      transcript: LONG_TRANSCRIPT,
      retrievals: [{ id: "mem-abc", name: "the-name", content: "the-content" }],
      taskContext: { sourceTaskId: "task-1", agentId: "agent-1" },
      apiUrl: "http://localhost:3013",
      apiKey: "k",
      _completeStructured: (async (opts: { userPrompt: string }) => {
        capturedUserPrompt = opts.userPrompt;
        return { summary: "x", ratings: [] };
      }) as any,
    });
    expect(capturedUserPrompt).toContain("mem-abc");
    expect(capturedUserPrompt).toContain("the-name");
    expect(capturedUserPrompt).toContain("the-content");
    // Confirms BASE_SUMMARIZE_PROMPT was used.
    expect(capturedUserPrompt).toContain("high-value learnings");
    // Confirms transcript was included.
    expect(capturedUserPrompt).toContain("Transcript:");
  });

  test("includes Task: line in prompt when taskContext.prompt provided", async () => {
    let capturedUserPrompt = "";
    await summarizeSession({
      harness: "codex",
      transcript: LONG_TRANSCRIPT,
      retrievals: [],
      taskContext: { sourceTaskId: "task-1", agentId: "agent-1", prompt: "do the thing" },
      apiUrl: "http://localhost:3013",
      apiKey: "k",
      _completeStructured: (async (opts: { userPrompt: string }) => {
        capturedUserPrompt = opts.userPrompt;
        return { summary: "x", ratings: [] };
      }) as any,
    });
    expect(capturedUserPrompt).toContain("Task: do the thing");
  });

  test("degenerate transcript (≤ 100 chars) returns null without invoking _completeStructured", async () => {
    let invocations = 0;
    const result = await summarizeSession({
      harness: "opencode",
      transcript: "tiny",
      retrievals: [],
      taskContext: { sourceTaskId: "task-1", agentId: "agent-1" },
      apiUrl: "http://localhost:3013",
      apiKey: "k",
      _completeStructured: (async () => {
        invocations++;
        return { summary: "x", ratings: [] };
      }) as any,
    });
    expect(result).toBeNull();
    expect(invocations).toBe(0);
  });

  test("callerTag is derived as session-summary:<harness>", async () => {
    let capturedTag = "";
    await summarizeSession({
      harness: "pi",
      transcript: LONG_TRANSCRIPT,
      retrievals: [],
      taskContext: { sourceTaskId: "task-1", agentId: "agent-1" },
      apiUrl: "http://localhost:3013",
      apiKey: "k",
      _completeStructured: (async (opts: { callerTag?: string }) => {
        capturedTag = opts.callerTag ?? "";
        return { summary: "x", ratings: [] };
      }) as any,
    });
    expect(capturedTag).toBe("session-summary:pi");
  });
});
