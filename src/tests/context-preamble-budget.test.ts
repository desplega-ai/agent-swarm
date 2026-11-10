import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

// Budgets are read at import time. Use a fresh process per configuration so
// module caching and the parent test runner's environment cannot mask a failure.
const probe = `
  import {
    buildContextPreamble,
    buildResumeContextPreamble,
    CONTEXT_PREAMBLE_MAX_TOKENS,
    CONTEXT_PREAMBLE_RESUME_MAX_TOKENS,
  } from ${JSON.stringify(resolve(import.meta.dir, "../commands/context-preamble.ts"))};

  globalThis.fetch = async (url) => {
    if (new URL(url).pathname.endsWith("/session-logs")) return Response.json({ logs: [] });
    return Response.json({
      id: "parent",
      task: "Original brief: " + "work ".repeat(10000),
      output: "Prior result: " + "done ".repeat(10000),
    });
  };
  console.log(JSON.stringify({
    normalTokens: CONTEXT_PREAMBLE_MAX_TOKENS,
    resumeTokens: CONTEXT_PREAMBLE_RESUME_MAX_TOKENS,
    normal: await buildContextPreamble("http://preamble.test", "", "parent"),
    resume: await buildResumeContextPreamble("http://preamble.test", "", "parent"),
  }));
`;

describe("context preamble environment budgets", () => {
  test.each([
    [undefined, undefined, 2000, 4000],
    ...["", " ", "abc", "NaN", "Infinity", "-Infinity", "0", "-1", "1.5", "1e309", "1e308"].map(
      (value) => [value, value, 2000, 4000] as const,
    ),
    ["300", "600", 300, 600],
    ["3000", "5000", 3000, 5000],
  ] as const)(
    "normal=%s resume=%s preserves bounded context",
    async (normalValue, resumeValue, normalTokens, resumeTokens) => {
      const result = await runChild([process.execPath, "--eval", probe], {
        env: {
          ...process.env,
          CONTEXT_PREAMBLE_MAX_TOKENS: normalValue,
          CONTEXT_PREAMBLE_RESUME_MAX_TOKENS: resumeValue,
          STEERING_ENABLED: "false",
        },
      });
      const actual = JSON.parse(expectChildOk(result, "context preamble budget probe").stdout);
      expect(actual.normalTokens).toBe(normalTokens);
      expect(actual.resumeTokens).toBe(resumeTokens);
      expect(actual.normal).toContain("Prior result: done");
      expect(actual.normal).toMatch(/\[(?:output|context preamble) truncated/);
      expect(actual.normal.length).toBeLessThan(normalTokens * 4 + 100);
      expect(actual.resume).toContain("Original brief: work");
      expect(actual.resume).toContain(
        `[resume preamble truncated to ${resumeTokens}-token budget]`,
      );
      expect(actual.resume.length).toBeGreaterThan(resumeTokens * 4);
      expect(actual.resume.length).toBeLessThan(resumeTokens * 4 + 100);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
