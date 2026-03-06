import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { prettyPrintLine } from "../utils/pretty-print.ts";

const originalLog = console.log;

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

describe("prettyPrintLine", () => {
  const logs: string[] = [];

  beforeEach(() => {
    logs.length = 0;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("suppresses noisy pi lifecycle deltas", () => {
    prettyPrintLine(JSON.stringify({ type: "turn_start" }), "worker");
    prettyPrintLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", delta: "x" },
      }),
      "worker",
    );

    expect(logs).toHaveLength(0);
  });

  test("pretty prints pi tool execution start", () => {
    prettyPrintLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "bash",
        toolInput: { command: "echo hi" },
      }),
      "lead",
    );

    const output = stripAnsi(logs.join("\n"));
    expect(output).toContain("Tool: bash");
    expect(output).toContain("command=");
  });

  test("pretty prints pi assistant message_end blocks", () => {
    prettyPrintLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "All workers responded." }],
        },
      }),
      "lead",
    );

    const output = stripAnsi(logs.join("\n"));
    expect(output).toContain("Assistant:");
    expect(output).toContain("All workers responded.");
  });
});
