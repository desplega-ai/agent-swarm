import { describe, expect, test } from "bun:test";
// Relative: the root `bun test` does not resolve the UI's `@/` alias at runtime.
import { extractSubagentRuns, parseSessionLogs, type SessionLogRecord } from "../../logs-parser";
import { formatDur, spawnCallUsage } from "./session-log-messages";

const ISO = "2026-10-05T11:36:33.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(ISO) + seconds * 1000).toISOString();
}

describe("formatDur", () => {
  test("ms, seconds, minutes, and nothing for zero", () => {
    expect(formatDur(0)).toBe("");
    expect(formatDur(450)).toBe("450ms");
    expect(formatDur(9800)).toBe("9.8s");
    expect(formatDur(42_000)).toBe("42s");
    expect(formatDur(176_000)).toBe("2m 56s");
    expect(formatDur(120_000)).toBe("2m");
  });
});

describe("spawnCallUsage", () => {
  function claude(
    id: string,
    lineNumber: number,
    event: Record<string, unknown>,
  ): SessionLogRecord {
    return {
      id,
      taskId: "task-1",
      sessionId: "session-1",
      iteration: 1,
      cli: "claude",
      content: JSON.stringify({ timestamp: at(lineNumber), ...event }),
      lineNumber,
      createdAt: at(lineNumber),
    };
  }
  const usage = {
    input_tokens: 6,
    cache_read_input_tokens: 90_000,
    cache_creation_input_tokens: 684,
    output_tokens: 120,
  };
  // An assistant line whose only block is an Agent call: the spawn record is
  // the run's, so its call_usage has no tool or text row of its own.
  const logs = [
    claude("spawn", 1, {
      type: "assistant",
      message: {
        id: "msg_spawn",
        role: "assistant",
        usage,
        content: [
          {
            type: "tool_use",
            id: "toolu_agent_1",
            name: "Agent",
            input: { description: "Inspect fixtures", prompt: "Look", subagent_type: "researcher" },
          },
        ],
      },
    }),
    claude("child", 2, {
      type: "assistant",
      parent_tool_use_id: "toolu_agent_1",
      message: {
        id: "msg_child",
        role: "assistant",
        usage: { ...usage, cache_read_input_tokens: 10_000 },
        content: [{ type: "text", text: "Looking." }],
      },
    }),
    claude("result", 3, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_agent_1", content: "Done." }],
      },
    }),
  ];

  test("an Agent-only assistant line gives its call's usage to the run", () => {
    const messages = parseSessionLogs(logs);
    const runs = extractSubagentRuns(logs);
    expect(runs.map((run) => run.id)).toEqual(["toolu_agent_1"]);
    // The mechanism: the call's usage block sits on a record the run owns.
    const spawnUsageMessage = messages.find(
      (m) =>
        !m.parentToolUseId &&
        m.content.some((b) => b.type === "provider_meta" && b.data.helperType === "call_usage"),
    );
    expect(runs[0]?.sourceRecordIds).toContain(spawnUsageMessage?.id ?? "");

    const byRun = spawnCallUsage(messages, new Set(["toolu_agent_1"]));
    expect(byRun.size).toBe(1);
    expect(byRun.get("toolu_agent_1")).toMatchObject({
      cacheReadTokens: 90_000,
      cacheWriteTokens: 684,
    });
  });

  test("the sub-agent's own calls and unknown runs give nothing", () => {
    const messages = parseSessionLogs(logs);
    expect(spawnCallUsage(messages, new Set()).size).toBe(0);
    expect(spawnCallUsage(messages.slice(1), new Set(["toolu_agent_1"])).size).toBe(0);
  });
});
