import { describe, expect, test } from "bun:test";
import { CASCADE_SKIP_RE, type SwarmTask } from "../types.ts";
import { INFRA_FAILURE_SIGNATURES, InfraTaskFailureError, processTerminalTask } from "./index.ts";

function task(overrides: Partial<SwarmTask>): SwarmTask {
  return {
    id: "task-1",
    title: "a task",
    description: "do things",
    status: "completed",
    ...overrides,
  };
}

describe("CASCADE_SKIP_RE (v6 §0.12 — frozen server format)", () => {
  test("matches the exact cascadeFailDependents() formats", () => {
    expect(CASCADE_SKIP_RE.test("Blocked dependency 1a2b3c4d was failed")).toBe(true);
    expect(CASCADE_SKIP_RE.test("Blocked dependency 1a2b3c4d was cancelled")).toBe(true);
    expect(CASCADE_SKIP_RE.test("Blocked dependency 1a2b3c4d was failed (cascade)")).toBe(true);
    expect(CASCADE_SKIP_RE.test("Blocked dependency deadbeef was superseded")).toBe(true);
  });

  test("does NOT match ordinary failureReasons", () => {
    expect(CASCADE_SKIP_RE.test("the model gave up")).toBe(false);
    expect(CASCADE_SKIP_RE.test("Spawn failed: Timeout waiting for server")).toBe(false);
    // anchored: the server format is a prefix, not a substring
    expect(CASCADE_SKIP_RE.test("note: Blocked dependency 1a2b3c4d was failed")).toBe(false);
    // uuid8 is lowercase hex, exactly 8 chars before " was "
    expect(CASCADE_SKIP_RE.test("Blocked dependency UPPERCAS was failed")).toBe(false);
    expect(CASCADE_SKIP_RE.test("Blocked dependency 1a2b was failed")).toBe(false);
  });
});

describe("infra-failure net (v6 §0.13/§12 — frozen precedence)", () => {
  const spawnReason = "Spawn failed: Timeout waiting for server to start after 5000ms";

  test("a terminal failed task with the opencode signature throws InfraTaskFailureError", () => {
    let thrown: unknown;
    try {
      processTerminalTask(task({ status: "failed", failureReason: spawnReason }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InfraTaskFailureError);
    const infra = thrown as InfraTaskFailureError;
    expect(infra.signatureId).toBe("opencode-spawn-timeout");
    expect(infra.taskId).toBe("task-1");
    // Frozen message shape: starts `infra failure (<signatureId>): task <taskId> failed with "..."`
    expect(
      infra.message.startsWith('infra failure (opencode-spawn-timeout): task task-1 failed with "'),
    ).toBe(true);
    expect(infra.message).toContain(spawnReason);
  });

  test("the failureReason in the message is clipped to 300 chars", () => {
    const longReason = `Spawn failed: Timeout waiting for server ${"x".repeat(600)}`;
    let thrown: InfraTaskFailureError | null = null;
    try {
      processTerminalTask(task({ status: "failed", failureReason: longReason }));
    } catch (err) {
      thrown = err as InfraTaskFailureError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain(`"${longReason.slice(0, 300)}"`);
    expect(thrown?.message.includes(longReason.slice(0, 301))).toBe(false);
  });

  test("signature precedence over skip classification when both could apply", () => {
    // Contrived reason matching BOTH the cascade prefix and an infra pattern:
    // the infra check must win (frozen §0.13 precedence — never a scored
    // attempt with skipped dependents from an infra flake).
    const both = "Blocked dependency 1a2b3c4d was failed: Spawn failed: Timeout waiting for server";
    expect(CASCADE_SKIP_RE.test(both)).toBe(true);
    expect(INFRA_FAILURE_SIGNATURES.some((s) => s.pattern.test(both))).toBe(true);
    expect(() => processTerminalTask(task({ status: "failed", failureReason: both }))).toThrow(
      InfraTaskFailureError,
    );
  });

  test("cascade-failed dependents are classified skipped, not thrown", () => {
    const result = processTerminalTask(
      task({ status: "failed", failureReason: "Blocked dependency 1a2b3c4d was failed" }),
    );
    expect(result.skipped).toBe(true);
    // the original record is not mutated
    expect(result.status).toBe("failed");
  });

  test("skip classification logs the frozen line", () => {
    const lines: string[] = [];
    processTerminalTask(
      task({ status: "failed", failureReason: "Blocked dependency 1a2b3c4d was cancelled" }),
      (msg) => lines.push(msg),
    );
    expect(lines).toContain("[task] task-1 skipped (failed dependency)");
  });

  test("non-matching failed tasks pass through untouched", () => {
    const original = task({ status: "failed", failureReason: "the model wrote bad code" });
    const result = processTerminalTask(original);
    expect(result).toEqual(original);
    expect(result.skipped).toBeUndefined();
  });

  test("non-'failed' statuses never trigger the net or the skip flag", () => {
    for (const status of ["completed", "cancelled", "superseded", "unknown"]) {
      const result = processTerminalTask(task({ status, failureReason: spawnReason }));
      expect(result.skipped).toBeUndefined();
      expect(result.status).toBe(status);
    }
  });

  test("null/absent failureReason is harmless", () => {
    expect(
      processTerminalTask(task({ status: "failed", failureReason: null })).skipped,
    ).toBeUndefined();
    expect(processTerminalTask(task({ status: "failed" })).skipped).toBeUndefined();
  });
});
