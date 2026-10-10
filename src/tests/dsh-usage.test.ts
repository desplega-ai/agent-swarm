import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSessionLogs, type SessionLogRecord } from "../../apps/ui/src/logs-parser";
import { DshAdapter } from "../providers/dsh-adapter";
import type { ProviderEvent } from "../providers/types";
import { addDshStepUsage, type DshStepUsage, normalizeDshStepUsage } from "../utils/dsh-usage";

// Real step_end rows from a 4-step dsh run on OpenRouter. Step 1 hit a cold
// cache (no cache field). Step 2 omits cacheReadTokens although its
// totalTokens carries 96,256 cached tokens: dsh-headless drops an optional
// bucket when any attempt of a retried step did not report it.
const STEPS = [
  { inputTokens: 96456, outputTokens: 250, totalTokens: 96706 },
  { inputTokens: 1691, outputTokens: 133, totalTokens: 98080 },
  { inputTokens: 1364, outputTokens: 250, totalTokens: 99406, cacheReadTokens: 97792 },
  { inputTokens: 520, outputTokens: 114, totalTokens: 99706, cacheReadTokens: 99072 },
];

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function dshLines(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [
    { type: "session", sessionId: "dsh-usage-session" },
    { type: "status", phase: "turn_start", turn: 1 },
  ];
  STEPS.forEach((usage, i) => {
    lines.push({ type: "status", phase: "step_start", turn: 1, step: i + 1 });
    if (i < 3) {
      const callId = `call-${i + 1}`;
      lines.push({
        type: "tool_call",
        callId,
        tool: i < 2 ? "mcp__agent-swarm__get-tasks" : "mcp__agent-swarm__store-progress",
        input: { mineOnly: true },
      });
      lines.push({ type: "tool_result", callId, status: "ok", result: "ok" });
    }
    lines.push({ type: "status", phase: "step_end", turn: 1, step: i + 1, usage });
  });
  lines.push({ type: "text", text: "Done" });
  lines.push({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
  lines.push({ type: "final", text: "Done" });
  return lines;
}

describe("dsh usage normalization", () => {
  test("derives a missing cacheReadTokens from totalTokens", () => {
    const steps = STEPS.map((usage) => normalizeDshStepUsage(usage) as DshStepUsage);
    expect(steps.map((step) => step.cacheRead)).toEqual([0, 96256, 97792, 99072]);
    // Present fields win: the derived value equals the reported one on steps 3-4.
    expect(normalizeDshStepUsage({ ...STEPS[2], totalTokens: 1 })?.cacheRead).toBe(97792);
    expect(
      normalizeDshStepUsage({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 40,
        cacheWriteTokens: 5,
      })?.cacheRead,
    ).toBe(20);
    expect(normalizeDshStepUsage(undefined)).toBeNull();
    expect(steps.reduce<DshStepUsage | undefined>(addDshStepUsage, undefined)).toEqual({
      input: 100031,
      output: 747,
      cacheRead: 293120,
      cacheWrite: 0,
      reasoning: 0,
    });
  });

  test("the cost row and the log turn summary count the same tokens and turns", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-usage-test-"));
    directories.push(cwd);
    const binary = join(cwd, "dsh");
    await Bun.write(
      binary,
      `#!${process.execPath}
await Bun.stdin.text();
for (const line of ${JSON.stringify(dshLines())}) console.log(JSON.stringify(line));
`,
    );
    await chmod(binary, 0o700);
    const session = await new DshAdapter().createSession({
      prompt: "go",
      systemPrompt: "",
      model: "openrouter/qwen/qwen3.8-flash",
      role: "worker",
      agentId: "agent-test",
      taskId: "task-test",
      apiUrl: "http://unused.invalid",
      apiKey: "unused",
      cwd,
      logFile: join(cwd, "log.jsonl"),
      env: { DSH_BINARY: binary, OPENROUTER_API_KEY: "openrouter-test-key" },
    });
    const events: ProviderEvent[] = [];
    session.onEvent((event) => events.push(event));
    const result = await session.waitForCompletion();

    expect(result.cost).toMatchObject({
      inputTokens: 100031,
      cacheReadTokens: 293120,
      outputTokens: 747,
      numTurns: 1,
    });

    // Progress comes from tool calls, never from dsh phase names.
    expect(events.filter((event) => event.type === "progress")).toEqual([]);
    expect(
      events.flatMap((event) => (event.type === "tool_start" ? [event.toolName] : [])),
    ).toEqual([
      "mcp__agent-swarm__get-tasks",
      "mcp__agent-swarm__get-tasks",
      "mcp__agent-swarm__store-progress",
    ]);
    expect(events).toContainEqual({
      type: "tool_end",
      toolCallId: "call-3",
      toolName: "mcp__agent-swarm__store-progress",
      result: "ok",
    });

    // The log viewer reads the same raw lines the runner stores.
    const records: SessionLogRecord[] = events
      .flatMap((event) => (event.type === "raw_log" ? [event.content] : []))
      .map((content, i) => ({
        id: `line-${i}`,
        taskId: "task-test",
        sessionId: "session-1",
        iteration: 1,
        cli: "dsh",
        content,
        lineNumber: i,
        createdAt: "2026-10-01T19:24:00.000Z",
      }));
    const turn = normalizeSessionLogs(records).items.find(
      (item) => (item.meta as { type?: string } | undefined)?.type === "turn.completed",
    );
    const meta = turn?.meta as { steps: number; usage: Record<string, number> };
    expect(meta.steps).toBe(4);
    expect(meta.usage).toEqual({
      input_tokens: result.cost!.inputTokens + result.cost!.cacheReadTokens!,
      cached_input_tokens: result.cost!.cacheReadTokens,
      output_tokens: result.cost!.outputTokens,
    });
  });
});
