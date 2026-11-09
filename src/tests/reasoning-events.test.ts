import { describe, expect, test } from "bun:test";
import { parseSessionLogs, type SessionLogRecord } from "../../apps/ui/src/logs-parser";
import { classifyClaudeThinking, extractReasoning } from "../utils/reasoning-events";

// Shapes trimmed from post-deploy reasoning-capture control rows; text replaced.
const claudeLine = (content: unknown[], id = "msg_A") =>
  JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-5-5", id, type: "message", role: "assistant", content },
    parent_tool_use_id: null,
    thinking_display: "summarized",
  });

const FIXTURES: Record<string, { cli: string; line: string; chars: number | null }> = {
  claude: {
    cli: "claude",
    line: claudeLine([{ type: "thinking", thinking: "Check the plan first.", signature: "SIG" }]),
    chars: 21,
  },
  claudeOmitted: {
    cli: "claude",
    line: claudeLine([{ type: "thinking", thinking: "", signature: "SIG" }]),
    chars: 0,
  },
  codex: {
    cli: "codex",
    line: JSON.stringify({
      type: "item.completed",
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: ["Read the file", "then patch"],
        content: [],
      },
    }),
    chars: "Read the file\nthen patch".length,
  },
  codexEmpty: {
    cli: "codex",
    line: JSON.stringify({
      type: "item.completed",
      item: { id: "rs_2", type: "reasoning", summary: [], content: [] },
    }),
    chars: 0,
  },
  opencode: {
    cli: "opencode",
    line: JSON.stringify({
      id: "evt_1",
      type: "session.reasoning.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "Plan steps." },
    }),
    chars: 11,
  },
  pi: {
    cli: "pi",
    line: JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "abc" },
          { type: "thinking", thinking: "defgh" },
          { type: "text", text: "382" },
        ],
        model: "nan/deepseek-v4-flash",
      },
    }),
    chars: 8,
  },
  cursor: {
    cli: "cursor",
    line: JSON.stringify({ type: "thinking", text: "Look at tests.", thinking_duration_ms: 5 }),
    chars: 14,
  },
  dsh: { cli: "dsh", line: JSON.stringify({ type: "thinking", text: "hmm" }), chars: 3 },
  claudeText: { cli: "claude", line: claudeLine([{ type: "text", text: "Done." }]), chars: null },
};

describe("extractReasoning", () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    test(`${name}: chars ${f.chars}`, () => {
      expect(extractReasoning(f.cli, f.line).reasoning?.chars ?? null).toBe(f.chars);
    });
  }

  test("pi line with two thinking blocks counts both", () => {
    expect(extractReasoning("pi", FIXTURES.pi.line).reasoning).toEqual({ chars: 8, blocks: 2 });
  });

  test("claude tool_use line gives its message id and no reasoning", () => {
    const line = claudeLine([{ type: "tool_use", id: "tu_1", name: "Read", input: {} }], "msg_T");
    expect(extractReasoning("claude", line)).toEqual({
      reasoning: null,
      toolUseMessageId: "msg_T",
    });
    // pi has no update rule, so no lookup is triggered.
    expect(extractReasoning("pi", line)).toEqual({ reasoning: null });
  });

  test("claude thinking line carries its message id", () => {
    expect(extractReasoning("claude", FIXTURES.claude.line).reasoning?.messageId).toBe("msg_A");
  });

  test("malformed and untracked lines give null", () => {
    expect(extractReasoning("claude", "not json {")).toEqual({ reasoning: null });
    expect(extractReasoning("claude", "[1,2]")).toEqual({ reasoning: null });
    expect(
      extractReasoning(
        "acp",
        JSON.stringify({
          update: { sessionUpdate: "agent_thought_chunk", content: { text: "x" } },
        }),
      ),
    ).toEqual({ reasoning: null });
    expect(
      extractReasoning(
        "codex",
        JSON.stringify({ type: "item.started", item: { type: "reasoning", summary: ["x"] } }),
      ),
    ).toEqual({ reasoning: null });
  });

  test("parity: chars equals the UI parser's reasoning text length", () => {
    for (const [name, f] of Object.entries(FIXTURES)) {
      const rec: SessionLogRecord = {
        id: name,
        sessionId: "s",
        iteration: 1,
        cli: f.cli,
        content: f.line,
        lineNumber: 0,
        createdAt: "2026-11-08T20:00:00.000Z",
      };
      const uiChars = parseSessionLogs([rec])
        .flatMap((m) => m.content)
        .reduce((n, b) => n + (b.type === "thinking" ? b.thinking.length : 0), 0);
      expect({ name, chars: extractReasoning(f.cli, f.line).reasoning?.chars ?? 0 }).toEqual({
        name,
        chars: uiChars,
      });
    }
  });
});

describe("classifyClaudeThinking", () => {
  const t = { type: "thinking" };
  const tool = { type: "tool_use" };
  const text = { type: "text" };

  test("one thinking block before tool_use stays reasoning (every message in the sample)", () => {
    expect(classifyClaudeThinking([t, tool, tool])).toEqual(["reasoning"]);
  });

  test("two or more thinking blocks before tool_use: the last is update", () => {
    expect(classifyClaudeThinking([t, t, tool])).toEqual(["reasoning", "update"]);
    expect(classifyClaudeThinking([t, t, t, tool])).toEqual(["reasoning", "reasoning", "update"]);
  });

  test("a text block breaks the run; no tool_use means no update", () => {
    expect(classifyClaudeThinking([t, t, text, tool])).toEqual(["reasoning", "reasoning"]);
    expect(classifyClaudeThinking([t, t, text])).toEqual(["reasoning", "reasoning"]);
  });
});
