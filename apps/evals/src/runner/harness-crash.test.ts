import { describe, expect, test } from "bun:test";
import type { SwarmTask } from "../types.ts";
import {
  classifyFailureReason,
  classifyNoOutputTimeout,
  HARNESS_CRASH_SIGNATURES,
  HarnessCrashError,
} from "./harness-crash.ts";

/**
 * Failure reasons below are copied from stored attempts (evals-replica.db,
 * 2026-09-28): 3 context overflows and a dead provider stream in 219 failed
 * attempts, plus the model-caused failures that must never match.
 */

describe("classifyFailureReason", () => {
  test("context overflow (OpenRouter wording) is a non-retryable harness crash", () => {
    const crash = classifyFailureReason(
      '400: {"message":"This endpoint\'s maximum context length is 131072 tokens. However, you requested about 187245 tokens (183149 of text input, 4096 in the output)."}',
    );
    expect(crash?.kind).toBe("context-overflow");
    expect(crash?.retryable).toBe(false);
  });

  test("other providers' overflow wording", () => {
    expect(classifyFailureReason("prompt is too long: 213420 tokens > 200000 maximum")?.kind).toBe(
      "context-overflow",
    );
    expect(classifyFailureReason('{"error":{"code":"context_length_exceeded"}}')?.kind).toBe(
      "context-overflow",
    );
  });

  test("a dead provider stream is a retryable provider error", () => {
    const crash = classifyFailureReason("JSON error injected into SSE stream");
    expect(crash?.kind).toBe("provider-error");
    expect(crash?.retryable).toBe(true);
  });

  test("provider error bodies and overloaded/rate-limit statuses", () => {
    expect(
      classifyFailureReason('{"type":"error","error":{"type":"overloaded_error"}}')?.kind,
    ).toBe("provider-error");
    expect(classifyFailureReason("529 overloaded_error: Overloaded")?.kind).toBe("provider-error");
    expect(classifyFailureReason("503 Service Unavailable")?.kind).toBe("provider-error");
    expect(classifyFailureReason("Provider returned error")?.kind).toBe("provider-error");
  });

  test("a subscription session limit is a non-retryable provider error, not a model failure", () => {
    const crash = classifyFailureReason(
      "Session error (exit code 1): You've hit your session limit · resets 12pm (UTC)",
    );
    expect(crash?.kind).toBe("provider-error");
    expect(crash?.retryable).toBe(false);
  });

  test("model-caused failures never match", () => {
    for (const reason of [
      'tool-loop: Detected ping-pong loop: alternating between "get-task-details" and "get-task-details" for 6 calls.',
      "Task depends on Phase One output (completed task IDs) which is not available. Searched: /workspace/shared",
      "Blocked dependency dcfe3a1b was failed",
      "Blocked dependency ec91f0aa was cancelled",
      "Cancelled to repair an invalid phase-one dependency ID; will recreate this chain with verified IDs.",
      "Test task created only for script validation - script test complete",
      "the agent wrote 500 lines but the tests return 503 rows instead of 5",
      "",
    ]) {
      expect({ reason, crash: classifyFailureReason(reason) }).toEqual({ reason, crash: null });
    }
    expect(classifyFailureReason(null)).toBeNull();
    expect(classifyFailureReason(undefined)).toBeNull();
  });

  test("every signature is a kind the runner knows and carries a pattern", () => {
    for (const sig of HARNESS_CRASH_SIGNATURES) {
      expect(["context-overflow", "provider-error"]).toContain(sig.kind);
      expect(sig.pattern).toBeInstanceOf(RegExp);
    }
  });

  test("the persisted detail is clipped", () => {
    const crash = classifyFailureReason(
      `maximum context length is 1000 tokens ${"x".repeat(2000)}`,
    );
    expect(crash?.detail.length).toBe(300);
  });
});

describe("classifyNoOutputTimeout", () => {
  const task = (
    over: Partial<SwarmTask> & { timedOut?: boolean },
  ): SwarmTask & {
    timedOut?: boolean;
  } => ({ id: "t1", title: "t", description: "d", status: "in_progress", ...over });

  test("a timed-out task with no session-log row never ran: harness crash", () => {
    const hit = classifyNoOutputTimeout([task({ timedOut: true })], []);
    expect(hit?.task.id).toBe("t1");
    expect(hit?.crash.kind).toBe("no-output-timeout");
    expect(hit?.crash.retryable).toBe(true);
  });

  test("a slow agent that logged anything is a model failure, left to the tasks-completed gate", () => {
    expect(classifyNoOutputTimeout([task({ timedOut: true })], [{ taskId: "t1" }])).toBeNull();
  });

  test("a task that finished, failed or was skipped never counts", () => {
    expect(classifyNoOutputTimeout([task({ status: "completed" })], [])).toBeNull();
    expect(classifyNoOutputTimeout([task({ status: "failed" })], [])).toBeNull();
    expect(classifyNoOutputTimeout([task({ timedOut: true, skipped: true })], [])).toBeNull();
  });

  test("logs of another task do not excuse this one", () => {
    const hit = classifyNoOutputTimeout(
      [task({ id: "a", timedOut: true }), task({ id: "b" })],
      [{ taskId: "b" }],
    );
    expect(hit?.task.id).toBe("a");
  });
});

describe("HarnessCrashError", () => {
  test("names the kind and the task, and says it is excluded", () => {
    const err = new HarnessCrashError(
      { kind: "context-overflow", retryable: false, detail: "too long" },
      "t9",
    );
    expect(err.name).toBe("HarnessCrashError");
    expect(err.message).toContain("harness crash (context-overflow): task t9");
    expect(err.message).toContain("Excluded from scores");
  });
});
