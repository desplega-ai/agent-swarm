import { describe, expect, test } from "bun:test";
import { AgentFsError } from "../agent-fs/client";
import type { DiffChange } from "../agent-fs/types";
import { COMB_LOG_LIMIT } from "./comments";
import {
  canRevert,
  formatDiffRange,
  newerVersion,
  parseDiffRange,
  revertOutcome,
  reviewRange,
  reviewRangeNotice,
  reviewsThread,
  showReviewEntry,
} from "./review";

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

describe("showReviewEntry", () => {
  const stat = (contentType: string) => ({ contentType, size: 1200, currentVersion: 3 });

  test("markdown, text, and table files with a version", () => {
    expect(showReviewEntry("/docs/notes.md", stat("text/markdown"))).toBe(true);
    expect(showReviewEntry("/src/app.ts", stat("text/plain"))).toBe(true);
    expect(showReviewEntry("/data/rows.csv", stat("text/csv"))).toBe(true);
  });

  test("never for media and binary files", () => {
    expect(showReviewEntry("/img/logo.png", stat("image/png"))).toBe(false);
    expect(showReviewEntry("/docs/spec.pdf", stat("application/pdf"))).toBe(false);
    expect(showReviewEntry("/clip.mp4", stat("video/mp4"))).toBe(false);
    expect(showReviewEntry("/archive.zip", stat("application/zip"))).toBe(false);
  });

  test("never without a version", () => {
    const unversioned = { ...stat("text/markdown"), currentVersion: undefined };
    expect(showReviewEntry("/docs/notes.md", unversioned)).toBe(false);
  });
});

describe("reviewRangeNotice", () => {
  const md = { contentType: "text/markdown", size: 100, currentVersion: 4 };

  test("a range up to the current version opens", () => {
    expect(reviewRangeNotice({ from: 1, to: 4 }, "/a.md", md)).toBeNull();
    expect(reviewRangeNotice({ from: 1, to: 2 }, "/a.md", md)).toBeNull();
  });

  test("a range past the current version is a notice, not a dead end", () => {
    expect(reviewRangeNotice({ from: 1, to: 99 }, "/a.md", md)).toBe(
      "This file has no v99. The latest version is v4.",
    );
  });

  test("no versions, or a file that is not text", () => {
    expect(
      reviewRangeNotice({ from: 1, to: 2 }, "/a.md", { ...md, currentVersion: undefined }),
    ).toBe("This file has no versions to compare.");
    expect(
      reviewRangeNotice({ from: 1, to: 2 }, "/a.png", { ...md, contentType: "image/png" }),
    ).toBe("Comb compares versions of text files only.");
  });
});

describe("reviewsThread", () => {
  test("only the thread's own range", () => {
    const thread = { fileVersion: 1, createdAt: "2026-09-30T10:00:00Z" };
    expect(reviewsThread(thread, { from: 1, to: 3 }, 3)).toBe(true);
    // Versions menu (2..3), or a head that moved on (1..3 while the file is at v4).
    expect(reviewsThread(thread, { from: 2, to: 3 }, 3)).toBe(false);
    expect(reviewsThread(thread, { from: 1, to: 3 }, 4)).toBe(false);
    // A comment on the current version has nothing to review.
    expect(reviewsThread({ ...thread, fileVersion: 3 }, { from: 1, to: 3 }, 3)).toBe(false);
  });

  test("a comment without fileVersion matches through the log", () => {
    const thread = { createdAt: "2026-09-30T10:02:30Z" };
    const log = [
      { version: 3, createdAt: "2026-09-30T10:03:00Z" },
      { version: 2, createdAt: "2026-09-30T10:02:00Z" },
      { version: 1, createdAt: "2026-09-30T10:01:00Z" },
    ];
    expect(reviewsThread(thread, { from: 2, to: 3 }, 3)).toBe(false); // log not loaded yet
    expect(reviewsThread(thread, { from: 2, to: 3 }, 3, log)).toBe(true);
  });
});

describe("canRevert", () => {
  const changed: DiffChange[] = [
    { type: "remove", content: "a", oldLine: 1 },
    { type: "add", content: "b", newLine: 1 },
  ];
  const ready = { changes: changed, currentVersion: 3, to: 3, stale: false };

  test("after a loaded diff with changes, on the current head", () => {
    expect(canRevert(ready)).toBe(true);
  });

  test("not before the diff loads, or when it failed", () => {
    expect(canRevert({ ...ready, changes: undefined })).toBe(false);
  });

  test("not for a diff without changes", () => {
    expect(canRevert({ ...ready, changes: [] })).toBe(false);
    expect(canRevert({ ...ready, changes: [{ type: "context", content: "same" }] })).toBe(false);
  });

  test("not when the head moved on, or is unknown", () => {
    expect(canRevert({ ...ready, currentVersion: 4 })).toBe(false);
    expect(canRevert({ ...ready, currentVersion: undefined })).toBe(false);
  });

  test("not after a 409 until stat reloads", () => {
    expect(canRevert({ ...ready, stale: true })).toBe(false);
  });
});

describe("revertOutcome", () => {
  const conflict = new AgentFsError(
    409,
    "EDIT_CONFLICT",
    "Expected version 3 but file is at version 4",
  );

  test("no error: the revert landed", () => {
    expect(revertOutcome(null, 3, 3)).toEqual({ kind: "reverted" });
  });

  test("403: read-only", () => {
    expect(revertOutcome(new AgentFsError(403, "FORBIDDEN", "Forbidden"), 3, 3)).toEqual({
      kind: "read-only",
    });
  });

  test("409 with a newer head that stat already knows", () => {
    expect(revertOutcome(conflict, 4, 3)).toEqual({
      kind: "stale",
      newer: 4,
      message: "Expected version 3 but file is at version 4",
    });
  });

  test("409 before stat knows the newer head: the server's message, and no head", () => {
    expect(revertOutcome(conflict, 3, 3)).toEqual({
      kind: "stale",
      newer: null,
      message: "Expected version 3 but file is at version 4",
    });
    expect(revertOutcome(conflict, undefined, 3)).toMatchObject({ kind: "stale", newer: null });
  });

  test("anything else fails with its message", () => {
    expect(revertOutcome(new AgentFsError(0, "NETWORK", "Failed to fetch"), 3, 3)).toEqual({
      kind: "failed",
      message: "Failed to fetch",
    });
    expect(revertOutcome(new Error("boom"), 3, 3)).toEqual({ kind: "failed", message: "boom" });
  });

  test("newerVersion", () => {
    expect(newerVersion(5, 3)).toBe(5);
    expect(newerVersion(3, 3)).toBeNull();
    expect(newerVersion(undefined, 3)).toBeNull();
  });
});
