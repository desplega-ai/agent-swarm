import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Counter } from "@opentelemetry/api";
import {
  _injectCountersForTests,
  recordSessionCost,
  scrubOtelException,
  scrubOtelStatus,
} from "../otel-impl";

const SECRET = "ghp_1234567890abcdefghijklmnopqrstuv";

// Fake counter that records every add() call so tests can assert on the args.
const addSpy = mock((..._args: unknown[]) => {});
const fakeCounter = { add: addSpy } as unknown as Counter;

describe("otel-impl metric attribute scrubbing", () => {
  beforeEach(() => {
    addSpy.mockClear();
    _injectCountersForTests(fakeCounter, fakeCounter);
  });

  test("scrubs a token-like model value before Counter.add()", () => {
    // Simulate a model field that accidentally contains a GitHub PAT.
    // The token must not be preceded by a word char for the regex to match.
    const secretModel = `model/${SECRET}`; // '/' is non-word → regex fires
    recordSessionCost({
      totalCostUsd: 0.01,
      harness: "claude",
      model: secretModel,
      costSource: "harness",
      isError: false,
      tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, thinking: 0 },
    });

    expect(addSpy).toHaveBeenCalled();
    for (const call of addSpy.mock.calls) {
      const attrs = call[1] as Record<string, unknown>;
      expect(String(attrs.model)).not.toContain(SECRET);
      expect(String(attrs.model)).toContain("[REDACTED:");
    }
  });

  test("scrubs a token-like harness value before Counter.add()", () => {
    recordSessionCost({
      totalCostUsd: 0.01,
      harness: `Bearer ${SECRET}`,
      model: "claude-opus-4",
      costSource: "pricing-table",
      isError: false,
      tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, thinking: 0 },
    });

    expect(addSpy).toHaveBeenCalled();
    for (const call of addSpy.mock.calls) {
      const attrs = call[1] as Record<string, unknown>;
      expect(String(attrs.harness)).not.toContain(SECRET);
    }
  });

  test("zero totalCostUsd skips cost counter but still records tokens", () => {
    recordSessionCost({
      totalCostUsd: 0,
      harness: "codex",
      model: "gpt-4o",
      costSource: "unpriced",
      isError: false,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, thinking: 0 },
    });

    // Two tokenCounter.add() calls (input + output), zero costCounter.add()
    expect(addSpy.mock.calls.length).toBe(2);
    const tokenTypes = addSpy.mock.calls.map((c) => (c[1] as Record<string, unknown>).token_type);
    expect(tokenTypes).toContain("input");
    expect(tokenTypes).toContain("output");
  });

  test("all six token_type values are emitted when non-zero", () => {
    recordSessionCost({
      totalCostUsd: 0.1,
      harness: "claude",
      model: "claude-sonnet-4-6",
      costSource: "pricing-table",
      isError: false,
      tokens: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        reasoning: 20,
        thinking: 15,
      },
    });

    const tokenCalls = addSpy.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>).token_type !== undefined,
    );
    const emittedTypes = tokenCalls.map((c) => (c[1] as Record<string, unknown>).token_type);
    expect(emittedTypes.sort()).toEqual(
      ["cacheRead", "cacheWrite", "input", "output", "reasoning", "thinking"].sort(),
    );
  });
});

describe("otel-impl exception / status scrubbing", () => {
  test("scrubs Error messages and stacks before recording exceptions", () => {
    const error = new Error(`request failed with token ${SECRET}`);
    error.stack = `Error: request failed with token ${SECRET}\n    at fake`;

    const scrubbed = scrubOtelException(error);

    expect(scrubbed).toBeInstanceOf(Error);
    expect((scrubbed as Error).message).not.toContain(SECRET);
    expect((scrubbed as Error).message).toContain("[REDACTED:github_token]");
    expect((scrubbed as Error).stack).not.toContain(SECRET);
  });

  test("scrubs non-Error exception values", () => {
    const scrubbed = scrubOtelException(`raw failure ${SECRET}`);

    expect(scrubbed).toBe("raw failure [REDACTED:github_token]");
  });

  test("scrubs span status messages", () => {
    const status = scrubOtelStatus({
      code: 2,
      message: `worker failed with token ${SECRET}`,
    });

    expect(status.message).toBe("worker failed with token [REDACTED:github_token]");
  });
});
