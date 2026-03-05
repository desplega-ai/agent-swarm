import { describe, expect, test } from "bun:test";
import {
  extractHookBlockDecision,
  mapPiSdkEventToHookInvocations,
} from "../commands/providers/runtime-hook-bridge.ts";

describe("runtime hook bridge", () => {
  test("maps pi tool start event to PreToolUse payload", () => {
    const invocations = mapPiSdkEventToHookInvocations({
      type: "tool_execution_start",
      toolName: "Read",
      input: { file_path: "/tmp/demo.txt" },
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual({
      hookEventName: "PreToolUse",
      payload: {
        tool_name: "Read",
        tool_input: { file_path: "/tmp/demo.txt" },
      },
    });
  });

  test("maps pi tool end event to PostToolUse payload", () => {
    const invocations = mapPiSdkEventToHookInvocations({
      type: "tool_execution_end",
      tool_name: "Write",
      output: { ok: true },
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual({
      hookEventName: "PostToolUse",
      payload: {
        tool_name: "Write",
        tool_response: { ok: true },
      },
    });
  });

  test("does not map pi lifecycle events to avoid duplicate SessionStart/Stop", () => {
    expect(mapPiSdkEventToHookInvocations({ type: "agent_start" })).toEqual([]);
    expect(mapPiSdkEventToHookInvocations({ type: "session_start" })).toEqual([]);
    expect(mapPiSdkEventToHookInvocations({ type: "agent_end" })).toEqual([]);
    expect(mapPiSdkEventToHookInvocations({ type: "session_end" })).toEqual([]);
  });

  test("detects hook block response from mixed stdout", () => {
    const decision = extractHookBlockDecision(
      `status line\n{"decision":"block","reason":"cancelled"}\n`,
    );

    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("cancelled");
  });

  test("returns not blocked when no block JSON present", () => {
    const decision = extractHookBlockDecision("regular logs only");

    expect(decision).toEqual({ blocked: false });
  });
});
