/**
 * A client that disconnects mid-request fires neither `finish` nor `error` —
 * `wireHttpSpanLifecycle` (used by `src/http/index.ts`) handles that via
 * `res.on("close", ...)`. Two invariants on that path:
 *
 *  1. `http.response.status_code` must not report the pre-`writeHead` `200`
 *     default when no response was ever sent (self-contradicts
 *     `agentswarm.http.aborted: true`).
 *  2. The span status must stay Unset — OTel HTTP semconv reserves ERROR for
 *     5xx, and a client abort is the normal SSE teardown path for /mcp and
 *     /mcp-user.
 *
 * (1) is a pure function (`abortedStatusCodeAttribute`), tested directly.
 * (2), plus the end-exactly-once guarantee across `finish`/`error`/`close` in
 * every firing order, is exercised against `wireHttpSpanLifecycle` with a
 * mocked response and span — extracted out of `src/http/index.ts` (which
 * binds a port at module scope, see `shutdown-error-scrubbing.test.ts`)
 * specifically so this lifecycle is testable without reading source text.
 */

import { describe, expect, test } from "bun:test";
import {
  abortedStatusCodeAttribute,
  type SpanLifecycleResponse,
  wireHttpSpanLifecycle,
} from "../http/utils";
import type { Attributes, SpanStatus, SwarmSpan } from "../otel";

function createMockResponse(headersSent: boolean) {
  const listeners: Record<string, ((err?: Error) => void)[]> = {};
  const res: SpanLifecycleResponse & {
    emit: (event: "finish" | "error" | "close", err?: Error) => void;
  } = {
    headersSent,
    on(event, listener) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
      return res;
    },
    emit(event, err) {
      for (const listener of listeners[event] ?? []) listener(err);
    },
  };
  return res;
}

function createMockSpan() {
  const attributeCalls: Attributes[] = [];
  const statusCalls: SpanStatus[] = [];
  let endCalls = 0;
  const span: SwarmSpan = {
    setAttribute: () => span,
    setAttributes: (attrs) => {
      attributeCalls.push(attrs);
      return span;
    },
    addEvent: () => span,
    recordException: () => {},
    setStatus: (status) => {
      statusCalls.push(status);
      return span;
    },
    end: () => {
      endCalls += 1;
    },
  };
  return { span, attributeCalls, statusCalls, getEndCalls: () => endCalls };
}

describe("abortedStatusCodeAttribute", () => {
  test("omits the status code when no response was ever sent", () => {
    expect(abortedStatusCodeAttribute(false, 200)).toBeUndefined();
  });

  test("reports the real status code once headers were sent", () => {
    expect(abortedStatusCodeAttribute(true, 404)).toBe(404);
  });
});

describe("wireHttpSpanLifecycle", () => {
  test("a premature close (no finish, no error) ends the span exactly once, marks aborted, omits the fabricated status", () => {
    const res = createMockResponse(false);
    const { span, attributeCalls, statusCalls, getEndCalls } = createMockSpan();
    wireHttpSpanLifecycle(res, span, () => 200, performance.now());

    res.emit("close");

    expect(getEndCalls()).toBe(1);
    expect(attributeCalls.at(-1)).toMatchObject({ "agentswarm.http.aborted": true });
    // headersSent is false — must not claim the pre-writeHead 200 default was sent.
    expect(attributeCalls.at(-1)?.["http.response.status_code"]).toBeUndefined();
    // A client abort is not a 5xx — status must stay Unset, not ERROR.
    expect(statusCalls).toEqual([]);
  });

  test("close firing before a would-be finish leaves the span ended — finish is a no-op", () => {
    const res = createMockResponse(true);
    const { span, getEndCalls } = createMockSpan();
    wireHttpSpanLifecycle(res, span, () => 200, performance.now());

    res.emit("close");
    res.emit("finish");

    // Deleting the guard (or the close handler's `span.end()`) would leave
    // this at 0 or let a second `end()` land — either way the count moves.
    expect(getEndCalls()).toBe(1);
  });

  test("close after headers were sent reports the real status code, not the 200 default", () => {
    const res = createMockResponse(true);
    const { span, attributeCalls } = createMockSpan();
    wireHttpSpanLifecycle(res, span, () => 404, performance.now());

    res.emit("close");

    expect(attributeCalls.at(-1)?.["http.response.status_code"]).toBe(404);
  });

  test("finish then close (the happy-path order) ends the span exactly once and never marks aborted", () => {
    const res = createMockResponse(true);
    const { span, attributeCalls, getEndCalls } = createMockSpan();
    wireHttpSpanLifecycle(res, span, () => 200, performance.now());

    res.emit("finish");
    res.emit("close");

    expect(getEndCalls()).toBe(1);
    for (const attrs of attributeCalls) {
      expect(attrs).not.toHaveProperty("agentswarm.http.aborted");
    }
  });

  test("a 5xx finish sets ERROR status; close arriving after it is a no-op", () => {
    const res = createMockResponse(true);
    const { span, statusCalls, getEndCalls } = createMockSpan();
    wireHttpSpanLifecycle(res, span, () => 503, performance.now());

    res.emit("finish");
    res.emit("close");

    expect(getEndCalls()).toBe(1);
    expect(statusCalls).toEqual([{ code: 2, message: "HTTP 503" }]);
  });

  test("error ends the span exactly once and records ERROR status; a later close is a no-op", () => {
    const res = createMockResponse(false);
    const { span, statusCalls, getEndCalls } = createMockSpan();
    wireHttpSpanLifecycle(res, span, () => 200, performance.now());

    res.emit("error", new Error("boom"));
    res.emit("close");

    expect(getEndCalls()).toBe(1);
    expect(statusCalls).toEqual([{ code: 2, message: "boom" }]);
  });
});
