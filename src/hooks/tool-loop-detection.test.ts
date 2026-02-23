import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkToolLoop, clearToolHistory } from "./tool-loop-detection";

const SESSION_KEY = "test-session-loop-detection";

beforeEach(async () => {
  await clearToolHistory(SESSION_KEY);
});

afterEach(async () => {
  await clearToolHistory(SESSION_KEY);
});

describe("tool-loop-detection", () => {
  describe("checkToolLoop — no loop", () => {
    test("returns not blocked for first call", async () => {
      const result = await checkToolLoop(SESSION_KEY, "Read", { file_path: "/foo.ts" });
      expect(result.blocked).toBe(false);
      expect(result.severity).toBeUndefined();
    });

    test("returns not blocked for varied tool calls", async () => {
      // Simulate 10 different tool calls — should never trigger
      for (let i = 0; i < 10; i++) {
        const result = await checkToolLoop(SESSION_KEY, "Read", {
          file_path: `/file-${i}.ts`,
        });
        expect(result.blocked).toBe(false);
      }
    });

    test("returns not blocked below warning threshold", async () => {
      // 7 identical calls (threshold is 8)
      for (let i = 0; i < 7; i++) {
        const result = await checkToolLoop(SESSION_KEY, "Bash", { command: "ls" });
        expect(result.blocked).toBe(false);
      }
    });
  });

  describe("checkToolLoop — same-tool repeat detection", () => {
    test("returns warning at 8 identical calls", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      for (let i = 0; i < 8; i++) {
        result = await checkToolLoop(SESSION_KEY, "Read", { file_path: "/same.ts" });
      }
      expect(result!.blocked).toBe(false);
      expect(result!.severity).toBe("warning");
      expect(result!.reason).toContain("8 times");
      expect(result!.reason).toContain("Read");
    });

    test("returns critical/blocked at 15 identical calls", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      for (let i = 0; i < 15; i++) {
        result = await checkToolLoop(SESSION_KEY, "Grep", { pattern: "foo", path: "/bar" });
      }
      expect(result!.blocked).toBe(true);
      expect(result!.severity).toBe("critical");
      expect(result!.reason).toContain("15 times");
      expect(result!.reason).toContain("Grep");
      expect(result!.reason).toContain("stuck in a loop");
    });

    test("does not trigger for different args on same tool", async () => {
      for (let i = 0; i < 20; i++) {
        const result = await checkToolLoop(SESSION_KEY, "Read", {
          file_path: `/unique-${i}.ts`,
        });
        expect(result.blocked).toBe(false);
        // Should not have "critical" severity for unique calls
        if (result.severity === "critical") {
          throw new Error(`Unexpected critical at iteration ${i}`);
        }
      }
    });
  });

  describe("checkToolLoop — ping-pong detection", () => {
    test("detects alternating two-tool pattern at critical threshold", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      // Alternate between two patterns for 12+ calls
      for (let i = 0; i < 14; i++) {
        if (i % 2 === 0) {
          result = await checkToolLoop(SESSION_KEY, "Read", { file_path: "/a.ts" });
        } else {
          result = await checkToolLoop(SESSION_KEY, "Edit", {
            file_path: "/a.ts",
            old_string: "x",
            new_string: "y",
          });
        }
      }
      // At 14 calls alternating between 2 patterns (7+7=14 >= 12 critical threshold)
      // and dominance is 100% (14/14 >= 80%)
      expect(result!.blocked).toBe(true);
      expect(result!.severity).toBe("critical");
      expect(result!.reason).toContain("ping-pong");
    });

    test("warns on ping-pong at warning threshold", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      // Do 6 alternating calls (3+3=6 >= PINGPONG_WARNING_THRESHOLD)
      // But we need enough history for the check to trigger (>= 6 history length)
      for (let i = 0; i < 8; i++) {
        if (i % 2 === 0) {
          result = await checkToolLoop(SESSION_KEY, "Bash", { command: "npm test" });
        } else {
          result = await checkToolLoop(SESSION_KEY, "Read", { file_path: "/test.ts" });
        }
      }
      // With 8 calls (4+4), dominance is 8/8=100% >= 80%, and 8 >= 6 warning threshold
      // Should be at least warning (might be critical at 8 since >= 6 warning)
      expect(result!.severity).toBeDefined();
      expect(["warning", "critical"]).toContain(result!.severity!);
    });
  });

  describe("clearToolHistory", () => {
    test("clears history so subsequent calls start fresh", async () => {
      // Build up history
      for (let i = 0; i < 10; i++) {
        await checkToolLoop(SESSION_KEY, "Read", { file_path: "/same.ts" });
      }

      // Clear
      await clearToolHistory(SESSION_KEY);

      // Next call should be clean (below threshold)
      const result = await checkToolLoop(SESSION_KEY, "Read", { file_path: "/same.ts" });
      expect(result.blocked).toBe(false);
      expect(result.severity).toBeUndefined();
    });
  });

  describe("hashArgs — determinism", () => {
    test("identical args produce same detection behavior regardless of key order", async () => {
      // Call with keys in different order — should be treated the same
      await clearToolHistory(SESSION_KEY);

      for (let i = 0; i < 8; i++) {
        // Alternate key order
        if (i % 2 === 0) {
          await checkToolLoop(SESSION_KEY, "Edit", { file_path: "/a.ts", old_string: "x" });
        } else {
          await checkToolLoop(SESSION_KEY, "Edit", { old_string: "x", file_path: "/a.ts" });
        }
      }

      // Should trigger warning since hashArgs sorts keys — all 8 calls are identical
      const result = await checkToolLoop(SESSION_KEY, "Edit", {
        file_path: "/a.ts",
        old_string: "x",
      });
      expect(result.severity).toBe("warning");
    });
  });
});
