import { describe, expect, test } from "bun:test";
import { COMB_LOG_LIMIT } from "./comments";
import { formatDiffRange, parseDiffRange, reviewRange } from "./review";

describe("parseDiffRange", () => {
  test("reads from..to and orders the pair", () => {
    expect(parseDiffRange("1..2")).toEqual({ from: 1, to: 2 });
    expect(parseDiffRange("7..3")).toEqual({ from: 3, to: 7 });
    expect(formatDiffRange({ from: 3, to: 7 })).toBe("3..7");
  });

  test("rejects anything else", () => {
    for (const value of [
      null,
      "",
      "2",
      "2..2",
      "0..3",
      "1...2",
      "-1..2",
      "a..b",
      "1..2x",
      "1.5..3",
    ]) {
      expect(parseDiffRange(value)).toBeNull();
    }
  });
});

describe("reviewRange", () => {
  const log = [
    { version: 3, createdAt: "2026-09-30T10:03:00Z" },
    { version: 2, createdAt: "2026-09-30T10:02:00Z" },
    { version: 1, createdAt: "2026-09-30T10:01:00Z" },
  ];

  test("compares the comment's version with the current one", () => {
    expect(reviewRange({ fileVersion: 1, createdAt: "x" }, 3)).toEqual({ from: 1, to: 3 });
  });

  test("nothing to review on the current version, or without one", () => {
    expect(reviewRange({ fileVersion: 3, createdAt: "x" }, 3)).toBeNull();
    expect(reviewRange({ fileVersion: 1, createdAt: "x" }, undefined)).toBeNull();
  });

  test("a comment without fileVersion takes it from the log", () => {
    const thread = { createdAt: "2026-09-30T10:02:30Z" };
    expect(reviewRange(thread, 3)).toBeNull(); // log not loaded yet
    expect(reviewRange(thread, 3, log)).toEqual({ from: 2, to: 3 });
    // Older than every version of a complete log: unknown.
    expect(reviewRange({ createdAt: "2026-09-30T09:00:00Z" }, 3, log)).toBeNull();
  });

  test("a full log stands in with its oldest version", () => {
    const full = Array.from({ length: COMB_LOG_LIMIT }, (_, i) => ({
      version: 300 - i,
      createdAt: new Date(Date.UTC(2026, 8, 30, 12, 0, 0) - i * 60_000).toISOString(),
    }));
    expect(reviewRange({ createdAt: "2026-01-01T00:00:00Z" }, 300, full)).toEqual({
      from: 101,
      to: 300,
    });
  });
});
