import { describe, expect, test } from "bun:test";
import { RESUME_DEPRECATED_REASON, resolveResumeSession } from "../commands/resume-session";

// Native resume was deprecated in the 2026-05-28 plan. resolveResumeSession
// is now an observability shim — it records the candidates that would have
// been resume targets in the old world, but never returns a resumeSessionId.

describe("resolveResumeSession (observability shim)", () => {
  test("returns no resumeSessionId for any candidate", () => {
    const resolution = resolveResumeSession("claude", [
      {
        source: "task",
        sessionId: "69dbe5a1-1130-45eb-983f-58a7a13c9c3c",
        provider: "claude",
      },
    ]);

    expect(resolution.resumeSessionId).toBeUndefined();
    expect(resolution.source).toBeUndefined();
    expect(resolution.provider).toBeUndefined();
  });

  test("records every non-empty candidate in skipped with the deprecation reason", () => {
    const resolution = resolveResumeSession("claude", [
      {
        source: "task",
        sessionId: "69dbe5a1-1130-45eb-983f-58a7a13c9c3c",
        provider: "claude",
      },
      {
        source: "parent",
        sessionId: "sesn_resume_xyz",
        provider: "claude",
        providerMeta: { managed: true },
      },
    ]);

    expect(resolution.skipped).toHaveLength(2);
    for (const entry of resolution.skipped) {
      expect(entry.reason).toBe(RESUME_DEPRECATED_REASON);
    }
    expect(resolution.skipped[0]?.source).toBe("task");
    expect(resolution.skipped[0]?.sessionId).toBe("69dbe5a1-1130-45eb-983f-58a7a13c9c3c");
    expect(resolution.skipped[1]?.source).toBe("parent");
    expect(resolution.skipped[1]?.sessionId).toBe("sesn_resume_xyz");
  });

  test("ignores candidates with empty / whitespace-only sessionId", () => {
    const resolution = resolveResumeSession("claude", [
      { source: "task", sessionId: undefined },
      { source: "task", sessionId: null },
      { source: "task", sessionId: "" },
      { source: "parent", sessionId: "   " },
    ]);

    expect(resolution.skipped).toEqual([]);
    expect(resolution.resumeSessionId).toBeUndefined();
  });

  test("preserves the candidate provider in the skipped entry for observability", () => {
    const resolution = resolveResumeSession("claude", [
      {
        source: "task",
        sessionId: "thread-codex",
        provider: "codex",
      },
    ]);

    expect(resolution.skipped).toHaveLength(1);
    expect(resolution.skipped[0]?.provider).toBe("codex");
    expect(resolution.skipped[0]?.reason).toBe(RESUME_DEPRECATED_REASON);
  });

  test("currentProvider is ignored — same skipped output regardless", () => {
    const candidates = [
      { source: "task" as const, sessionId: "abc-123", provider: "claude" as const },
    ];
    const a = resolveResumeSession("claude", candidates);
    const b = resolveResumeSession("pi", candidates);
    const c = resolveResumeSession("codex", candidates);

    expect(a.skipped).toEqual(b.skipped);
    expect(b.skipped).toEqual(c.skipped);
  });
});
