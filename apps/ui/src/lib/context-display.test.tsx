import { describe, expect, test } from "bun:test";
import type { ContextSnapshot } from "@/api/types";
import { findLatestUsableContextSnapshot } from "./context-display";

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    id: "snapshot-1",
    taskId: "task-1",
    agentId: "agent-1",
    sessionId: "session-1",
    eventType: "progress",
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    createdAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("findLatestUsableContextSnapshot", () => {
  test("skips a terminal snapshot that lacks a coherent usage set", () => {
    const usage = snapshot({
      contextUsedTokens: 191_533,
      contextTotalTokens: 1_050_000,
      contextPercent: 18.241238095238096,
      contextFormula: "input-cache-output",
    });
    const terminal = snapshot({
      id: "snapshot-2",
      eventType: "completion",
      contextTotalTokens: 200_000,
    });

    expect(findLatestUsableContextSnapshot([usage, terminal])).toBe(usage);
  });

  test("returns no usage snapshot when each value comes from a different row", () => {
    const usedOnly = snapshot({ contextUsedTokens: 191_533 });
    const totalOnly = snapshot({ id: "snapshot-2", contextTotalTokens: 200_000 });
    const percentOnly = snapshot({ id: "snapshot-3", contextPercent: 18.241238095238096 });

    expect(findLatestUsableContextSnapshot([usedOnly, totalOnly, percentOnly])).toBeUndefined();
  });
});
