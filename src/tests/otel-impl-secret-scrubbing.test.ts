import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Counter, Tracer } from "@opentelemetry/api";
import {
  _injectCountersForTests,
  _injectTracerForTests,
  recordSessionCost,
  scrubOtelException,
  scrubOtelStatus,
  startSpan,
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

describe("otel-impl span attribute scrubbing", () => {
  // Built at runtime so no secret-shaped literal lands in the repo.
  const spanSecret = `gh${"p"}_${"W".repeat(36)}`;

  function recordingTracer() {
    const startAttributes: Array<Record<string, unknown> | undefined> = [];
    const setCalls: Array<[string, unknown]> = [];
    const setManyCalls: Array<Record<string, unknown>> = [];
    const span = {
      setAttribute: (key: string, value: unknown) => {
        setCalls.push([key, value]);
        return span;
      },
      setAttributes: (attrs: Record<string, unknown>) => {
        setManyCalls.push(attrs);
        return span;
      },
      addEvent: () => span,
      recordException: () => {},
      setStatus: () => span,
      end: () => {},
    };
    const tracer = {
      startSpan: (_name: string, options?: { attributes?: Record<string, unknown> }) => {
        startAttributes.push(options?.attributes);
        return span;
      },
    } as unknown as Tracer;
    return { tracer, startAttributes, setCalls, setManyCalls };
  }

  afterEach(() => {
    _injectTracerForTests(undefined);
  });

  test("setAttribute scrubs a string value and keeps the context", () => {
    const rec = recordingTracer();
    _injectTracerForTests(rec.tracer);
    startSpan("task").setAttribute("task.text", `deploy with ${spanSecret} now`);

    const [key, value] = rec.setCalls[0]!;
    expect(key).toBe("task.text");
    expect(String(value)).not.toContain(spanSecret);
    expect(String(value)).toContain("[REDACTED:");
    expect(String(value)).toContain("deploy with");
  });

  test("start attributes and setAttributes scrub strings and string arrays", () => {
    const rec = recordingTracer();
    _injectTracerForTests(rec.tracer);
    const span = startSpan("task", { "task.text": `x ${spanSecret}`, "task.count": 2 });
    span.setAttributes({ "tool.args": [`--token ${spanSecret}`, "--verbose"] });

    const start = rec.startAttributes[0]!;
    expect(JSON.stringify(start)).not.toContain(spanSecret);
    expect(String(start["task.text"])).toContain("[REDACTED:");
    expect(start["task.count"]).toBe(2);
    const many = rec.setManyCalls[0]!;
    expect(JSON.stringify(many)).not.toContain(spanSecret);
    expect((many["tool.args"] as string[])[1]).toBe("--verbose");
  });
});
