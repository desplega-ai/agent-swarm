import { describe, expect, test } from "bun:test";
import { boundLogLine } from "../commands/runner";

const LINE_MAX_BYTES = 1024 * 1024;
const byteLength = (value: string) => new TextEncoder().encode(value).length;

describe("worker log line bounds", () => {
  test("a line under the cap is untouched", () => {
    const line = JSON.stringify({ type: "assistant", text: "hello" });
    expect(boundLogLine(line)).toBe(line);
  });

  test("an oversized line is cut so a flush stays under the route's body cap", () => {
    // Without this the 17 MB event reaches POST /api/session-logs, which
    // answers 413 after flushLogBuffer already cleared the batch — taking
    // every neighbouring line with it.
    const huge = JSON.stringify({ type: "tool_end", result: "x".repeat(17 * 1024 * 1024) });
    const bounded = boundLogLine(huge);

    expect(byteLength(bounded)).toBeLessThanOrEqual(LINE_MAX_BYTES);
    expect(bounded).toContain("[truncated");
  });

  test("the truncation marker counts what was actually dropped", () => {
    // Not `length - cap`: the marker itself spends part of the budget, so a
    // 1-byte overflow drops more than one byte.
    const line = "x".repeat(LINE_MAX_BYTES + 1);
    const bounded = boundLogLine(line);
    const dropped = Number(bounded.match(/truncated (\d+) bytes/)?.[1]);
    const head = bounded.slice(0, bounded.indexOf(" [truncated "));

    expect(byteLength(head) + dropped).toBe(line.length);
  });

  test("the cap counts UTF-8 bytes, not UTF-16 units", () => {
    // 1.5M chars of a 3-byte character is 4.5 MB: `String.length` would call
    // this safely under a 1 MB cap.
    const bounded = boundLogLine("漢".repeat(1_500_000));

    expect(byteLength(bounded)).toBeLessThanOrEqual(LINE_MAX_BYTES);
    // A cut mid-sequence would leave U+FFFD behind.
    expect(bounded).not.toContain("\uFFFD");
  });
});
