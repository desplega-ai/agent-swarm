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

    test("returns critical/blocked at 15 identical fully-specified edits", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      for (let i = 0; i < 15; i++) {
        result = await checkToolLoop(SESSION_KEY, "Edit", {
          file_path: "/same.ts",
          old_string: "before",
          new_string: "after",
        });
      }
      expect(result!.blocked).toBe(true);
      expect(result!.severity).toBe("critical");
      expect(result!.reason).toContain("15 times");
      expect(result!.reason).toContain("Edit");
    });

    test("does not block normal codex file_change edits to the same file at 15 calls", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      for (let i = 0; i < 15; i++) {
        result = await checkToolLoop(SESSION_KEY, "Edit", {
          changes: [{ path: "src/be/db.ts", kind: "update" }],
        });
        expect(result.blocked).toBe(false);
      }
      expect(result!.severity).toBe("warning");
      expect(result!.reason).toContain("15 times");
    });

    test("still blocks prolonged codex file_change repetition", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      for (let i = 0; i < 24; i++) {
        result = await checkToolLoop(SESSION_KEY, "Edit", {
          changes: [{ path: "src/be/db.ts", kind: "update" }],
        });
      }
      expect(result!.blocked).toBe(true);
      expect(result!.severity).toBe("critical");
      expect(result!.reason).toContain("24 times");
      expect(result!.reason).toContain("Edit");
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

    test("does not block codex Edit↔bash at 14 calls (low-cardinality threshold)", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      // Simulate codex edit→test→edit loop: Edit has file_change args (low-cardinality),
      // bash has the same test command each time.
      for (let i = 0; i < 14; i++) {
        if (i % 2 === 0) {
          result = await checkToolLoop(SESSION_KEY, "Edit", {
            changes: [{ path: "src/be/db.ts", kind: "update" }],
          });
        } else {
          result = await checkToolLoop(SESSION_KEY, "Bash", { command: "bun test" });
        }
      }
      // At 14 calls, the normal threshold (12) would fire, but because codex
      // file_change args are low-cardinality, the threshold is raised to 24.
      expect(result!.blocked).toBe(false);
    });

    test("blocks codex Edit↔bash at 24 calls (low-cardinality critical)", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      for (let i = 0; i < 26; i++) {
        if (i % 2 === 0) {
          result = await checkToolLoop(SESSION_KEY, "Edit", {
            changes: [{ path: "src/be/db.ts", kind: "update" }],
          });
        } else {
          result = await checkToolLoop(SESSION_KEY, "Bash", { command: "bun test" });
        }
      }
      // At 26 calls (13+13=26 >= 24 low-cardinality critical threshold)
      expect(result!.blocked).toBe(true);
      expect(result!.severity).toBe("critical");
      expect(result!.reason).toContain("ping-pong");
    });

    test("does not block MCP script-upsert↔script-run with different sources", async () => {
      let result: Awaited<ReturnType<typeof checkToolLoop>> | undefined;
      // With the fixed hashArgs, different MCP arguments produce different hashes,
      // so alternating script-upsert (different source each time) and script-run
      // creates many distinct patterns, not just 2.
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          result = await checkToolLoop(SESSION_KEY, "script-upsert", {
            server: "agent-swarm",
            tool: "script-upsert",
            arguments: { name: "my-script", source: `console.log(${i})` },
          });
        } else {
          result = await checkToolLoop(SESSION_KEY, "script-run", {
            server: "agent-swarm",
            tool: "script-run",
            arguments: { name: "my-script" },
          });
        }
      }
      // script-upsert hashes differ (different source), so >2 patterns exist,
      // dominance of top 2 is below 80%. Should not be blocked.
      expect(result!.blocked).toBe(false);
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

  describe("hashArgs — determinism and nested key handling", () => {
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

    test("different nested args produce different hashes (not stripped)", async () => {
      // MCP-style nested args: different inner arguments should NOT hash the same.
      // The old hashArgs used a top-level-keys replacer that would strip nested
      // keys, making all calls to the same tool hash identically.
      await clearToolHistory(SESSION_KEY);

      for (let i = 0; i < 15; i++) {
        const result = await checkToolLoop(SESSION_KEY, "script-run", {
          server: "agent-swarm",
          tool: "script-run",
          arguments: { name: `script-${i}`, args: { input: i } },
        });
        // Each call has different nested args → different hash → never a repeat
        expect(result.blocked).toBe(false);
        if (result.severity === "critical") {
          throw new Error(`Unexpected critical at iteration ${i}`);
        }
      }
    });
  });
});
